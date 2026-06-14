# Generates appicon.png — a crimson "viewfinder + record dot" neko tile.
Add-Type -AssemblyName System.Drawing

$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

function RoundedPath($x, $y, $w, $h, $r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$pad = 96
$tile = $size - 2 * $pad
$rect = New-Object System.Drawing.Rectangle($pad, $pad, $tile, $tile)

# Cat ears (drawn first, behind the tile).
$earColor = [System.Drawing.Color]::FromArgb(255, 200, 20, 52)
$earBrush = New-Object System.Drawing.SolidBrush($earColor)
$leftEar = @(
  (New-Object System.Drawing.Point(($pad + 60), ($pad + 140))),
  (New-Object System.Drawing.Point(($pad + 70), ($pad - 60))),
  (New-Object System.Drawing.Point(($pad + 300), ($pad + 110)))
)
$rightEar = @(
  (New-Object System.Drawing.Point(($size - $pad - 60), ($pad + 140))),
  (New-Object System.Drawing.Point(($size - $pad - 70), ($pad - 60))),
  (New-Object System.Drawing.Point(($size - $pad - 300), ($pad + 110)))
)
$g.FillPolygon($earBrush, $leftEar)
$g.FillPolygon($earBrush, $rightEar)

# Tile with a crimson vertical gradient.
$path = RoundedPath $pad $pad $tile $tile 190
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(255, 255, 45, 85),
  [System.Drawing.Color]::FromArgb(255, 120, 0, 24),
  90)
$g.FillPath($grad, $path)

# Inner glow ring.
$cx = $size / 2; $cy = $size / 2 + 10
$white = [System.Drawing.Color]::FromArgb(245, 248, 234, 238)

# Four viewfinder corner brackets.
$penW = 46
$pen = New-Object System.Drawing.Pen($white, $penW)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$bx = $pad + 150; $by = $pad + 200
$ex = $size - $pad - 150; $ey = $size - $pad - 150
$len = 120
# top-left
$g.DrawLine($pen, $bx, $by, ($bx + $len), $by)
$g.DrawLine($pen, $bx, $by, $bx, ($by + $len))
# top-right
$g.DrawLine($pen, $ex, $by, ($ex - $len), $by)
$g.DrawLine($pen, $ex, $by, $ex, ($by + $len))
# bottom-left
$g.DrawLine($pen, $bx, $ey, ($bx + $len), $ey)
$g.DrawLine($pen, $bx, $ey, $bx, ($ey - $len))
# bottom-right
$g.DrawLine($pen, $ex, $ey, ($ex - $len), $ey)
$g.DrawLine($pen, $ex, $ey, $ex, ($ey - $len))

# Center record dot.
$dotR = 86
$dotBrush = New-Object System.Drawing.SolidBrush($white)
$g.FillEllipse($dotBrush, ($cx - $dotR), (($by + $ey) / 2 - $dotR), ($dotR * 2), ($dotR * 2))

$out = Join-Path $PSScriptRoot "appicon.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "Wrote $out"
