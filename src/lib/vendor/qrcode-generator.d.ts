/**
 * qrcode-generator(Kazuhiko Arase,MIT)的类型声明。
 * 源码在 src/lib/vendor/qrcode-generator.js,为项目内置,不依赖构建期下载。
 */

export interface QrCodeInstance {
  addData(data: string, mode?: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
  createImgTag(cellSize?: number, margin?: number, alt?: string): string;
  createSvgTag(cellSize?: number, margin?: number): string;
  createDataURL(cellSize?: number, margin?: number): string;
  createASCII(cellSize?: number, margin?: number): string;
  renderTo2dContext(context: CanvasRenderingContext2D, cellSize?: number): void;
}

/** typeNumber 传 0 表示按内容自动选择版本;errorCorrectionLevel 为 'L' | 'M' | 'Q' | 'H' */
declare function qrcode(typeNumber: number, errorCorrectionLevel: string): QrCodeInstance;

export default qrcode;
