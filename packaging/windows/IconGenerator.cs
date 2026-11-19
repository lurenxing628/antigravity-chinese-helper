using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;

namespace AntigravityChineseHelper
{
    // 原创图标：青绿色圆角底板、白色对话气泡与琥珀色光点，与 macOS 版视觉一致。
    public static class IconGenerator
    {
        private static readonly int[] IconSizes = new int[] { 16, 24, 32, 48, 64, 128, 256 };

        public static Bitmap RenderBitmap(int pixels)
        {
            Bitmap bitmap = new Bitmap(pixels, pixels, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bitmap))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                g.ScaleTransform(pixels / 1024f, pixels / 1024f);

                using (GraphicsPath plate = RoundedRect(52f, 52f, 920f, 920f, 206f))
                using (LinearGradientBrush plateBrush = new LinearGradientBrush(
                    new PointF(120f, 960f),
                    new PointF(904f, 64f),
                    Color.FromArgb(255, 13, 64, 82),
                    Color.FromArgb(255, 26, 145, 143)))
                {
                    g.FillPath(plateBrush, plate);
                }

                using (SolidBrush whiteBrush = new SolidBrush(Color.White))
                {
                    using (GraphicsPath bubble = RoundedRect(193f, 254f, 638f, 508f, 112f))
                    {
                        g.FillPath(whiteBrush, bubble);
                    }
                    PointF[] tail = new PointF[]
                    {
                        new PointF(285f, 719f),
                        new PointF(285f, 851f),
                        new PointF(453f, 719f)
                    };
                    g.FillPolygon(whiteBrush, tail);
                }

                using (Font font = CreateGlyphFont(340f))
                using (SolidBrush textBrush = new SolidBrush(Color.FromArgb(255, 15, 92, 105)))
                using (StringFormat format = new StringFormat(StringFormat.GenericTypographic))
                {
                    format.Alignment = StringAlignment.Center;
                    format.LineAlignment = StringAlignment.Center;
                    g.DrawString("汉", font, textBrush, new RectangleF(193f, 266f, 638f, 500f), format);
                }

                using (SolidBrush amberBrush = new SolidBrush(Color.FromArgb(255, 255, 181, 69)))
                {
                    g.FillEllipse(amberBrush, 741f, 163f, 126f, 126f);
                }
            }
            return bitmap;
        }

        public static void WriteIcoFile(string outputPath)
        {
            string dir = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            byte[][] pngFrames = new byte[IconSizes.Length][];
            for (int i = 0; i < IconSizes.Length; i++)
            {
                using (Bitmap bmp = RenderBitmap(IconSizes[i]))
                using (MemoryStream ms = new MemoryStream())
                {
                    bmp.Save(ms, ImageFormat.Png);
                    pngFrames[i] = ms.ToArray();
                }
            }

            using (FileStream fs = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.None))
            using (BinaryWriter writer = new BinaryWriter(fs))
            {
                // ICONDIR header
                writer.Write((ushort)0);
                writer.Write((ushort)1);
                writer.Write((ushort)IconSizes.Length);

                int offset = 6 + (16 * IconSizes.Length);
                for (int i = 0; i < IconSizes.Length; i++)
                {
                    int size = IconSizes[i];
                    byte widthByte = size >= 256 ? (byte)0 : (byte)size;
                    byte heightByte = size >= 256 ? (byte)0 : (byte)size;
                    int length = pngFrames[i].Length;

                    writer.Write(widthByte);
                    writer.Write(heightByte);
                    writer.Write((byte)0);
                    writer.Write((byte)0);
                    writer.Write((ushort)1);
                    writer.Write((ushort)32);
                    writer.Write(length);
                    writer.Write(offset);
                    offset += length;
                }

                for (int i = 0; i < pngFrames.Length; i++)
                {
                    writer.Write(pngFrames[i]);
                }
            }
        }

        public static Icon CreateRuntimeIcon()
        {
            using (MemoryStream ms = new MemoryStream())
            {
                using (Bitmap bmp16 = RenderBitmap(16))
                using (Bitmap bmp32 = RenderBitmap(32))
                using (Bitmap bmp48 = RenderBitmap(48))
                using (MemoryStream p16 = new MemoryStream())
                using (MemoryStream p32 = new MemoryStream())
                using (MemoryStream p48 = new MemoryStream())
                {
                    bmp16.Save(p16, ImageFormat.Png);
                    bmp32.Save(p32, ImageFormat.Png);
                    bmp48.Save(p48, ImageFormat.Png);
                    byte[][] frames = new byte[][] { p16.ToArray(), p32.ToArray(), p48.ToArray() };
                    int[] sizes = new int[] { 16, 32, 48 };

                    BinaryWriter writer = new BinaryWriter(ms);
                    writer.Write((ushort)0);
                    writer.Write((ushort)1);
                    writer.Write((ushort)frames.Length);
                    int offset = 6 + (16 * frames.Length);
                    for (int i = 0; i < frames.Length; i++)
                    {
                        writer.Write((byte)sizes[i]);
                        writer.Write((byte)sizes[i]);
                        writer.Write((byte)0);
                        writer.Write((byte)0);
                        writer.Write((ushort)1);
                        writer.Write((ushort)32);
                        writer.Write(frames[i].Length);
                        writer.Write(offset);
                        offset += frames[i].Length;
                    }
                    for (int i = 0; i < frames.Length; i++)
                    {
                        writer.Write(frames[i]);
                    }
                    writer.Flush();
                    ms.Position = 0;
                    return new Icon(ms);
                }
            }
        }

        private static Font CreateGlyphFont(float size)
        {
            string[] preferred = new string[] { "Microsoft YaHei UI", "Microsoft YaHei", "SimHei", "Segoe UI" };
            for (int i = 0; i < preferred.Length; i++)
            {
                try
                {
                    Font candidate = new Font(preferred[i], size, FontStyle.Bold, GraphicsUnit.Pixel);
                    if (string.Equals(candidate.Name, preferred[i], StringComparison.OrdinalIgnoreCase))
                    {
                        return candidate;
                    }
                    candidate.Dispose();
                }
                catch { }
            }
            return new Font(FontFamily.GenericSansSerif, size, FontStyle.Bold, GraphicsUnit.Pixel);
        }

        private static GraphicsPath RoundedRect(float x, float y, float width, float height, float radius)
        {
            float diameter = radius * 2f;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(x, y, diameter, diameter, 180f, 90f);
            path.AddArc(x + width - diameter, y, diameter, diameter, 270f, 90f);
            path.AddArc(x + width - diameter, y + height - diameter, diameter, diameter, 0f, 90f);
            path.AddArc(x, y + height - diameter, diameter, diameter, 90f, 90f);
            path.CloseFigure();
            return path;
        }
    }
}
