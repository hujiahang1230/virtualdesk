package com.virtualdesk.viewer;

import android.app.Activity;
import android.graphics.Color;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;

/**
 * 第二块屏 · 平板端
 *
 * 这是一个极简的低延迟视频接收端:从 PC 端(经 adb reverse 隧道)读裸 H.264,
 * 交给 MediaCodec 硬件解码,直接渲染到 SurfaceView。
 *
 * 为什么不用播放器(VLC):播放器自带缓冲与解封装,延迟通常在 100~500ms;
 * 副屏需要"跟手",所以这里完全跳过解封装 —— 协议已经是裸 Annex-B,
 * 只需按 AUD 切分访问单元,喂给解码器即可,从收到帧到上屏只有解码耗时。
 *
 * 为什么不用浏览器:浏览器无法在无交互的情况下自动全屏播放一个裸编码流,
 * 且每次都要开页面、点播放。这里装一次,PC 端一启动就自动出画面。
 *
 * 协议(见 PC 端 shell/Streamer.cs):
 *   "VDS1"            4 字节魔数
 *   width  (int32 LE) 4 字节
 *   height (int32 LE) 4 字节
 *   之后为连续的 Annex-B H.264(AUD 已插入,便于按访问单元切分)
 */
public class MainActivity extends Activity implements SurfaceHolder.Callback {

    private static final String TAG = "VirtualDesk";
    private static final int DEFAULT_PORT = 5000;
    /** 单调递增的呈现时间戳步长;解码器只用它做排序,不等于真实帧率 */
    private static final long FRAME_DURATION_US = 33_333L;

    /** Annex-B 起始码。拼访问单元与 csd 时必须带上 */
    private static final byte[] START_CODE = { 0, 0, 0, 1 };

    private SurfaceView surfaceView;
    private TextView statusView;
    private Surface surface;

    private volatile boolean running = true;
    private Thread worker;

    /** 首帧上屏后隐藏状态文字;每次重新连接都要复位 */
    private volatile boolean firstFrameShown = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 副屏不该自动熄屏
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        enterImmersive();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        surfaceView = new SurfaceView(this);
        surfaceView.getHolder().addCallback(this);
        root.addView(surfaceView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        statusView = new TextView(this);
        statusView.setTextColor(Color.parseColor("#E2E8F5"));
        statusView.setTextSize(14f);
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(32, 32, 32, 48);
        root.addView(statusView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        statusView.setText("正在连接电脑…");

        setContentView(root);

        int port = getIntent() == null ? DEFAULT_PORT
                : getIntent().getIntExtra("port", DEFAULT_PORT);
        Log.i(TAG, "启动,端口 " + port);

        worker = new Thread(() -> runLoop(port), "vd-receive");
        worker.setDaemon(true);
        worker.start();
    }

    private void enterImmersive() {
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersive();
    }

    // ------------------------------------------------------------ 接收循环

    /**
     * 断线自动重连:PC 端重启推流、或 USB 重新插拔后,这里会自动接上。
     */
    private void runLoop(int port) {
        while (running) {
            try {
                receiveOnce(port);
            } catch (Exception e) {
                Log.w(TAG, "连接中断:" + e.getMessage());
                if (running) {
                    setStatus("连接已断开,正在重试…\n" + e.getMessage());
                    sleepQuietly(1000);
                }
            }
        }
    }

    private void receiveOnce(int port) throws IOException {
        firstFrameShown = false;
        setStatus("正在连接 127.0.0.1:" + port + " …");
        Log.i(TAG, "连接 127.0.0.1:" + port);

        try (Socket socket = new Socket()) {
            socket.setTcpNoDelay(true);
            socket.setReceiveBufferSize(512 * 1024);
            socket.connect(new InetSocketAddress("127.0.0.1", port), 3000);

            InputStream raw = socket.getInputStream();
            BufferedInputStream in = new BufferedInputStream(raw, 256 * 1024);

            // ---- 读 12 字节头 ----
            byte[] header = readFully(in, 12);
            if (header[0] != 'V' || header[1] != 'D' || header[2] != 'S' || header[3] != '1') {
                throw new IOException("协议不匹配(不是 VDS1 流)");
            }
            int width = readInt32(header, 4);
            int height = readInt32(header, 8);
            Log.i(TAG, "视频尺寸 " + width + "x" + height);
            applyAspectRatio(width, height);
            setStatus("已连接,正在等待首帧…\n" + width + "×" + height);

            playStream(in, width, height);
        }
    }

    /**
     * 解码主循环。
     *
     * 关键点:按 AUD(NAL type 9)切分访问单元。PC 端已用
     * h264_metadata=aud=insert 插入 AUD,所以每个 AUD 之后的一组 NAL 恰好是一帧,
     * 不需要自己判断帧边界 —— 这是避免花屏/撕裂的关键。
     */
    private void playStream(InputStream in, int width, int height) throws IOException {
        MediaCodec codec = null;
        try {
            // Surface 可能还没就绪(surfaceCreated 异步回调),必须等,
            // 否则 configure(surface=null) 会把画面解到不存在的目标上,黑屏。
            for (int i = 0; i < 60 && surface == null && running; i += 1) {
                sleepQuietly(50);
            }
            if (surface == null) throw new IOException("显示表面未就绪");

            AnnexBReader reader = new AnnexBReader(in);

            ByteArrayOutputStream accessUnit = new ByteArrayOutputStream(256 * 1024);
            byte[] sps = null;
            byte[] pps = null;
            long ptsUs = 0;

            while (running) {
                byte[] nal = reader.nextNal();
                if (nal == null) break; // EOF
                if (nal.length == 0) continue;

                int type = nal[0] & 0x1F;

                if (type == 7) {                       // SPS
                    sps = nal;
                    continue;
                }
                if (type == 8) {                       // PPS
                    pps = nal;
                    continue;
                }
                if (type == 9) {                       // AUD = 一帧的边界
                    if (accessUnit.size() > 0) {
                        if (codec == null) {
                            codec = createDecoder(width, height, sps, pps);
                        }
                        feed(codec, accessUnit.toByteArray(), ptsUs);
                        ptsUs += FRAME_DURATION_US;
                        drain(codec);
                        accessUnit.reset();
                    }
                    continue;
                }

                // 其余 NAL(1 非关键片 / 5 关键片 / 6 SEI 等)拼进当前访问单元。
                //
                // 注意:必须把起始码补回去!AnnexBReader 交付的是**不含起始码**的 NAL 载荷,
                // 而 MediaCodec 的输入缓冲区要求标准 Annex-B(每个 NAL 前带 00 00 01)。
                // 第一版漏了这一步,结果解码器虽然 start 成功,却一帧都解不出来
                // (App 一直停在「正在等待首帧」)。
                accessUnit.write(START_CODE);
                accessUnit.write(nal);
            }

            if (codec != null) drain(codec);
        } finally {
            if (codec != null) {
                try {
                    codec.stop();
                } catch (Exception ignored) {
                }
                codec.release();
            }
        }
    }

    private MediaCodec createDecoder(int width, int height, byte[] sps, byte[] pps)
            throws IOException {
        // 第一次带低延迟参数;若厂商解码器不认这些可选键,退回最小配置再试一次。
        // (不同 ROM 的 MediaCodec 实现差异很大,不能假设都支持 KEY_LOW_LATENCY)
        try {
            return tryConfigure(width, height, sps, pps, true);
        } catch (Exception first) {
            Log.w(TAG, "带低延迟参数 configure 失败,改用最小配置:" + first.getMessage());
            return tryConfigure(width, height, sps, pps, false);
        }
    }

    private MediaCodec tryConfigure(int width, int height, byte[] sps, byte[] pps, boolean lowLatency)
            throws IOException {
        MediaCodec codec = MediaCodec.createDecoderByType("video/avc");
        MediaFormat format = MediaFormat.createVideoFormat("video/avc", width, height);

        if (sps != null) format.setByteBuffer("csd-0", ByteBuffer.wrap(withStartCode(sps)));
        if (pps != null) format.setByteBuffer("csd-1", ByteBuffer.wrap(withStartCode(pps)));

        if (lowLatency) {
            try {
                // 0 = 实时优先级
                format.setInteger(MediaFormat.KEY_PRIORITY, 0);
                if (android.os.Build.VERSION.SDK_INT >= 30) {
                    format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1);
                }
            } catch (Exception ignored) {
                // 个别实现会在 setInteger 时就抛,忽略即可
            }
        }

        try {
            codec.configure(format, surface, null, 0);
            codec.start();
        } catch (Exception e) {
            try {
                codec.release();
            } catch (Exception ignored) {
            }
            throw e instanceof IOException ? (IOException) e : new IOException(e);
        }

        Log.i(TAG, "解码器已启动 " + width + "x" + height + " (lowLatency=" + lowLatency + ")");
        return codec;
    }

    private void feed(MediaCodec codec, byte[] data, long ptsUs) {
        try {
            int index = codec.dequeueInputBuffer(10_000);
            if (index < 0) return; // 解码器忙,丢帧保实时
            ByteBuffer buffer = codec.getInputBuffer(index);
            if (buffer == null) return;
            buffer.clear();
            if (data.length > buffer.capacity()) {
                // 单帧超过输入缓冲,只能丢弃
                Log.w(TAG, "帧过大,丢弃 " + data.length + " 字节");
                codec.queueInputBuffer(index, 0, 0, ptsUs, 0);
                return;
            }
            buffer.put(data);
            codec.queueInputBuffer(index, 0, data.length, ptsUs, 0);
        } catch (IllegalStateException e) {
            Log.w(TAG, "喂数据失败:" + e.getMessage());
        }
    }

    private void drain(MediaCodec codec) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (true) {
            int index;
            try {
                index = codec.dequeueOutputBuffer(info, 0);
            } catch (IllegalStateException e) {
                return;
            }
            if (index == MediaCodec.INFO_TRY_AGAIN_LATER) return;
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) continue;
            if (index < 0) return;

            boolean render = info.size > 0;
            codec.releaseOutputBuffer(index, render);
            if (render && !firstFrameShown) {
                firstFrameShown = true;
                setStatus(null);
            }
        }
    }

    // ------------------------------------------------------------ 工具

    /** 给裸 NAL 载荷补上起始码(csd-0/csd-1 也要求 Annex-B 格式) */
    /**
     * 按视频宽高比调整 SurfaceView,保持等比并居中留边。
     *
     * 为什么必须做:SurfaceView 默认把缓冲区**拉伸**填满,而平板常见是 16:10 或
     * 2.36:1 的长屏、电脑虚拟屏通常是 16:9,直接拉伸会让画面变形(字被压扁/拉宽)。
     * 副屏要的是"看得清、不变形",所以宁可上下或左右留黑边。
     */
    private void applyAspectRatio(int videoWidth, int videoHeight) {
        if (videoWidth <= 0 || videoHeight <= 0) return;

        runOnUiThread(() -> {
            try {
                View parent = (View) surfaceView.getParent();
                if (parent == null) return;

                int availableWidth = parent.getWidth();
                int availableHeight = parent.getHeight();
                if (availableWidth <= 0 || availableHeight <= 0) {
                    // 布局还没测量完,等下一次(重连时还会再调一次)
                    return;
                }

                double videoAspect = (double) videoWidth / videoHeight;
                double screenAspect = (double) availableWidth / availableHeight;

                int targetWidth;
                int targetHeight;
                if (videoAspect > screenAspect) {
                    // 视频更宽:左右顶满,上下留边
                    targetWidth = availableWidth;
                    targetHeight = (int) Math.round(availableWidth / videoAspect);
                } else {
                    // 视频更高:上下顶满,左右留边
                    targetHeight = availableHeight;
                    targetWidth = (int) Math.round(availableHeight * videoAspect);
                }

                FrameLayout.LayoutParams params =
                        new FrameLayout.LayoutParams(targetWidth, targetHeight);
                params.gravity = Gravity.CENTER;
                surfaceView.setLayoutParams(params);

                Log.i(TAG, "画面布局 " + targetWidth + "x" + targetHeight
                        + "(容器 " + availableWidth + "x" + availableHeight + ")");
            } catch (Exception e) {
                Log.w(TAG, "调整画面比例失败:" + e.getMessage());
            }
        });
    }

    private static byte[] withStartCode(byte[] nal) {
        byte[] out = new byte[nal.length + 4];
        System.arraycopy(START_CODE, 0, out, 0, 4);
        System.arraycopy(nal, 0, out, 4, nal.length);
        return out;
    }

    private static byte[] readFully(InputStream in, int length) throws IOException {
        byte[] out = new byte[length];
        int offset = 0;
        while (offset < length) {
            int n = in.read(out, offset, length - offset);
            if (n < 0) throw new IOException("连接在读到完整头部前关闭");
            offset += n;
        }
        return out;
    }

    private static int readInt32(byte[] buffer, int offset) {
        return (buffer[offset] & 0xFF)
                | ((buffer[offset + 1] & 0xFF) << 8)
                | ((buffer[offset + 2] & 0xFF) << 16)
                | ((buffer[offset + 3] & 0xFF) << 24);
    }

    private void setStatus(final String text) {
        runOnUiThread(() -> {
            if (text == null) {
                statusView.setVisibility(View.GONE);
            } else {
                statusView.setVisibility(View.VISIBLE);
                statusView.setText(text);
            }
        });
    }

    private static void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // ------------------------------------------------------------ Surface

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        surface = holder.getSurface();
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        surface = holder.getSurface();
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        surface = null;
    }

    @Override
    protected void onDestroy() {
        running = false;
        if (worker != null) {
            try {
                worker.join(1500);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        super.onDestroy();
    }

    /**
     * 从 Annex-B 字节流里逐个取出 NAL(不含起始码)。
     *
     * 输入会被 TCP 任意切分,所以必须按字节状态机推进,不能假设一次 read 就是一个 NAL。
     *
     * 这里把"刚消费掉一个起始码"记在实例字段 haveStart 上 —— 否则每次调用都从
     * 「寻找起始码」开始,上一个 NAL 之后、下一个起始码之前的数据会被整段丢掉
     * (这个 bug 我写第一版时踩过:表现为只解出零星几帧)。
     */
    private static final class AnnexBReader {
        private final InputStream in;
        private boolean haveStart = false;
        private int previous2 = -1;
        private int previous1 = -1;

        AnnexBReader(InputStream in) {
            this.in = in;
        }

        byte[] nextNal() throws IOException {
            ByteArrayOutputStream collect = new ByteArrayOutputStream(16 * 1024);
            boolean collecting = haveStart;
            haveStart = false;
            if (collecting) {
                previous2 = -1;
                previous1 = -1;
            }

            while (true) {
                int b = in.read();
                if (b < 0) return collecting ? trim(collect) : null;

                boolean startCode = (previous2 == 0 && previous1 == 0 && b == 1);

                if (startCode) {
                    if (collecting) {
                        byte[] nal = trim(collect);
                        // 当前位置已经越过新起始码,下次直接从收集状态开始
                        haveStart = true;
                        previous2 = -1;
                        previous1 = -1;
                        if (nal != null) return nal;
                        collect = new ByteArrayOutputStream(16 * 1024);
                        continue;
                    }
                    collecting = true;
                    previous2 = -1;
                    previous1 = -1;
                    continue;
                }

                if (collecting) collect.write(b);
                previous2 = previous1;
                previous1 = b;
            }
        }

        /**
         * 去掉尾部属于下一个起始码的 00。
         *
         * 只去掉最多 3 个:起始码是 00 00 01 或 00 00 00 01,所以最多 3 个前导 0。
         * 第一版是"去掉所有尾部 0",理论上会误伤以 0x00 结尾的 NAL(H.264 的
         * rbsp_trailing_bits 保证实际不会,但没必要冒这个险)。
         */
        private static byte[] trim(ByteArrayOutputStream collect) {
            byte[] data = collect.toByteArray();
            int length = data.length;
            int removed = 0;
            while (length > 0 && data[length - 1] == 0 && removed < 3) {
                length -= 1;
                removed += 1;
            }
            if (length == 0) return null;
            byte[] nal = new byte[length];
            System.arraycopy(data, 0, nal, 0, length);
            return nal;
        }
    }
}
