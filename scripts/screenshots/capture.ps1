# Capture one window, frame included, into a PNG (works when the window is covered).
# With -Width and -Height, the window is first sized so its visible frame is exactly that many pixels.
param([Parameter(Mandatory = $true)][string]$Hwnd, [Parameter(Mandatory = $true)][string]$Out, [int]$Width = 0, [int]$Height = 0)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LooperShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
}
'@
[void][LooperShot]::SetProcessDpiAwarenessContext([IntPtr](-4))
$h = [IntPtr][Int64]$Hwnd
if ($Width -gt 0 -and $Height -gt 0) {
  # The outer rect includes invisible resize borders: size it so the visible frame matches.
  $o = New-Object LooperShot+RECT
  [void][LooperShot]::GetWindowRect($h, [ref]$o)
  $v = New-Object LooperShot+RECT
  [void][LooperShot]::DwmGetWindowAttribute($h, 9, [ref]$v, 16)
  $padW = ($o.Right - $o.Left) - ($v.Right - $v.Left)
  $padH = ($o.Bottom - $o.Top) - ($v.Bottom - $v.Top)
  # 0x0002|0x0004|0x0010 = SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE: no focus taken.
  [void][LooperShot]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, $Width + $padW, $Height + $padH, 0x16)
  Start-Sleep -Milliseconds 1500
}
$full = New-Object LooperShot+RECT
[void][LooperShot]::GetWindowRect($h, [ref]$full)
# The visible frame (without the invisible resize borders Windows 10/11 add).
$vis = New-Object LooperShot+RECT
[void][LooperShot]::DwmGetWindowAttribute($h, 9, [ref]$vis, 16)
$w = $full.Right - $full.Left
$hh = $full.Bottom - $full.Top
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][LooperShot]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$crop = New-Object System.Drawing.Rectangle ($vis.Left - $full.Left), ($vis.Top - $full.Top), ($vis.Right - $vis.Left), ($vis.Bottom - $vis.Top)
$out2 = $bmp.Clone($crop, $bmp.PixelFormat)
$out2.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$out2.Dispose()
$bmp.Dispose()
Write-Output "saved $Out ($($vis.Right - $vis.Left) x $($vis.Bottom - $vis.Top))"
