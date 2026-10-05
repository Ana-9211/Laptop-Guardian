#requires -Version 5.1
<# Generates src\assets\guardian.ico (shield + check, 16/32/48/256 px PNG-in-ICO). Run once; the .ico is committed. #>
param([string]$OutFile = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'assets\guardian.ico'))
Add-Type -AssemblyName System.Drawing
function New-Frame([int]$s) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)
    $k = $s / 32.0
    $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = 7 * $k; $d = 2 * $r
    $bg.AddArc(0, 0, $d, $d, 180, 90); $bg.AddArc($s - $d, 0, $d, $d, 270, 90); $bg.AddArc($s - $d, $s - $d, $d, $d, 0, 90); $bg.AddArc(0, $s - $d, $d, $d, 90, 90); $bg.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 18, 38, 58))), $bg)
    $accent = [System.Drawing.Color]::FromArgb(255, 56, 189, 160)
    $pen = New-Object System.Drawing.Pen $accent, ([single][Math]::Max(1.5, 2.2 * $k)); $pen.LineJoin = 'Round'; $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
    $pts = @( (New-Object System.Drawing.PointF (16 * $k), (5 * $k)), (New-Object System.Drawing.PointF (25 * $k), (8.5 * $k)), (New-Object System.Drawing.PointF (25 * $k), (15.7 * $k)), (New-Object System.Drawing.PointF (16 * $k), (27 * $k)), (New-Object System.Drawing.PointF (7 * $k), (15.7 * $k)), (New-Object System.Drawing.PointF (7 * $k), (8.5 * $k)) )
    $g.DrawPolygon($pen, [System.Drawing.PointF[]]$pts)
    $g.DrawLines($pen, [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF (11 * $k), (16.5 * $k)), (New-Object System.Drawing.PointF (14.4 * $k), (19.7 * $k)), (New-Object System.Drawing.PointF (21 * $k), (12.8 * $k))))
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    return ,$ms.ToArray()
}
$sizes = 16, 32, 48, 256
$frames = foreach ($s in $sizes) { , (New-Frame $s) }
$dir = Split-Path -Parent $OutFile; if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$fs = [System.IO.File]::Create($OutFile); $w = New-Object System.IO.BinaryWriter $fs
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $bytes = $frames[$i]
    $w.Write([byte]$(if ($s -ge 256) { 0 } else { $s })); $w.Write([byte]$(if ($s -ge 256) { 0 } else { $s })); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$bytes.Length); $w.Write([uint32]$offset)
    $offset += $bytes.Length
}
foreach ($b in $frames) { $w.Write($b) }
$w.Close(); $fs.Close()
Write-Host "Wrote $OutFile ($((Get-Item $OutFile).Length) bytes)"
