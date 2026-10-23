# Find a native message box by its title: capture it (-Out) and/or click a button (-Click <task dialog button id>).
param([Parameter(Mandatory = $true)][string]$Title, [string]$Out, [int]$Click = 0)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LooperDlg {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
[void][LooperDlg]::SetProcessDpiAwarenessContext([IntPtr](-4))
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 40 -and $h -eq [IntPtr]::Zero; $i++) {
  $h = [LooperDlg]::FindWindow('#32770', $Title)
  if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 }
}
if ($h -eq [IntPtr]::Zero) { Write-Output 'NO DIALOG'; exit 1 }
if ($Out) {
  Start-Sleep -Milliseconds 400
  $full = New-Object LooperDlg+RECT
  [void][LooperDlg]::GetWindowRect($h, [ref]$full)
  $vis = New-Object LooperDlg+RECT
  [void][LooperDlg]::DwmGetWindowAttribute($h, 9, [ref]$vis, 16)
  $bmp = New-Object System.Drawing.Bitmap ($full.Right - $full.Left), ($full.Bottom - $full.Top)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][LooperDlg]::PrintWindow($h, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $crop = New-Object System.Drawing.Rectangle ($vis.Left - $full.Left), ($vis.Top - $full.Top), ($vis.Right - $vis.Left), ($vis.Bottom - $vis.Top)
  $bmp.Clone($crop, $bmp.PixelFormat).Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "saved $Out"
}
if ($Click -ne 0) {
  # TDM_CLICK_BUTTON
  [void][LooperDlg]::SendMessage($h, 0x466, [IntPtr]$Click, [IntPtr]::Zero)
  Write-Output "clicked $Click"
}
