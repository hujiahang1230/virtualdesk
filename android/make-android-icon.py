"""
生成 Android 启动图标(自适应图标 + 传统图标)。

设计含义:「把平板变成第二块屏」。
  - 右上:一块大屏(电脑显示器,青色圆角描边)
  - 左下:一块小屏(平板,青色实心 + 深色内屏),与大屏叠压
  - 两者叠在一起表达"扩展出一块新屏幕",不用画箭头也读得懂

配色沿用 PC 端界面:深海军蓝(#0B1220 → #16324A)+ 青色(#22D3EE)。
只保留两块屏,保证缩到 48px 仍然能分辨。

输出(res/ 下):
  mipmap-<density>/ic_launcher.png            传统方形图标
  mipmap-<density>/ic_launcher_round.png      圆形图标
  mipmap-<density>/ic_launcher_foreground.png 自适应图标前景(透明,四周留安全边距)
  mipmap-anydpi-v26/ic_launcher.xml           自适应图标描述
  mipmap-anydpi-v26/ic_launcher_round.xml
  values/colors.xml                           图标背景色

用法: python make-android-icon.py [输出目录]
"""

import os
import sys

from PIL import Image, ImageDraw

# 超采样倍数:先按 4 倍画再缩小,圆角和斜边才不会有锯齿
SS = 4

BG_TOP = (11, 18, 32)
BG_BOTTOM = (22, 50, 74)
CYAN = (34, 211, 238)

DENSITIES = {
    'mdpi': 1.0,
    'hdpi': 1.5,
    'xhdpi': 2.0,
    'xxhdpi': 3.0,
    'xxxhdpi': 4.0,
}


def vertical_gradient(size, top, bottom):
    """一像素宽的竖条上采样成大图,得到纯竖向渐变。"""
    strip = Image.new('RGB', (1, size), top)
    draw = ImageDraw.Draw(strip)
    for y in range(size):
        t = y / max(1, size - 1)
        draw.point((0, y), fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return strip.resize((size, size), Image.BILINEAR)


def rounded_mask(size, radius):
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def circle_mask(size):
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
    return mask


def draw_motif(canvas_size, margin=0.15):
    """
    在透明画布上画「大屏 + 平板」。

    margin 是四周留白占画布的比例;图形用 0..1 的内容坐标铺满剩余区域,
    这样整体视觉重心接近画布中心,不会偏到一角。
    """
    size = canvas_size
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    box = size * (1 - 2 * margin)
    origin = size * margin

    def point(u, v):
        return origin + box * u, origin + box * v

    stroke = max(2, int(box * 0.052))

    # --- 主屏:右上,圆角描边;内部填一层青色,表示"屏幕亮着" ---
    screen = [point(0.34, 0.04), point(1.00, 0.44)]
    draw.rounded_rectangle(screen, radius=int(box * 0.09), fill=CYAN + (58,))
    draw.rounded_rectangle(screen, radius=int(box * 0.09), outline=CYAN, width=stroke)

    # --- 平板:左下,青色实心(与大屏形成"实 / 虚"对比);略横向,像个平板 ---
    tx0, ty0 = point(0.00, 0.54)
    tx1, ty1 = point(0.54, 0.98)
    draw.rounded_rectangle(
        [tx0, ty0, tx1, ty1], radius=int(box * 0.075), fill=CYAN,
    )

    return layer


def build_legacy(px_size, round_icon=False):
    """传统图标:不透明底 + 图形,外层按方形(带圆角)或圆形裁剪。"""
    big = px_size * SS
    # 圆形裁切会切掉四角,所以圆形版本把图形缩小一点,避免边角被啃掉
    margin = 0.18 if round_icon else 0.13
    composed = Image.alpha_composite(
        vertical_gradient(big, BG_TOP, BG_BOTTOM).convert('RGBA'),
        draw_motif(big, margin=margin),
    )
    composed.putalpha(circle_mask(big) if round_icon else rounded_mask(big, int(big * 0.22)))
    return composed.resize((px_size, px_size), Image.LANCZOS)


def build_foreground(dp_size):
    """
    自适应图标前景:透明底。

    108dp 的画布会被启动器按不同形状裁切,只有中心约 72dp 保证可见,
    所以这里把留白加大到 0.19,让图形落在安全区内。
    """
    big = dp_size * SS
    return draw_motif(big, margin=0.19).resize((dp_size, dp_size), Image.LANCZOS)


ADAPTIVE_XML = '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
'''

COLORS_XML = '''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- 图标背景:与 PC 端界面同色系的深海军蓝 -->
    <color name="ic_launcher_background">#0B1220</color>
</resources>
'''


def write_text(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(content)


def main():
    default_root = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'app', 'src', 'main', 'res')
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else default_root)
    print(f'输出目录: {root}')

    for density, scale in DENSITIES.items():
        folder = os.path.join(root, f'mipmap-{density}')
        os.makedirs(folder, exist_ok=True)

        legacy_px = round(48 * scale)
        build_legacy(legacy_px).save(os.path.join(folder, 'ic_launcher.png'))
        build_legacy(legacy_px, round_icon=True).save(os.path.join(folder, 'ic_launcher_round.png'))
        build_foreground(round(108 * scale)).save(os.path.join(folder, 'ic_launcher_foreground.png'))
        print(f'  {density}: 传统 {legacy_px}px / 前景 {round(108 * scale)}px')

    for name in ('ic_launcher.xml', 'ic_launcher_round.xml'):
        write_text(os.path.join(root, 'mipmap-anydpi-v26', name), ADAPTIVE_XML)
    write_text(os.path.join(root, 'values', 'colors.xml'), COLORS_XML)

    print('完成:传统图标 / 圆形图标 / 自适应前景 / 自适应描述 / 颜色资源')


if __name__ == '__main__':
    main()
