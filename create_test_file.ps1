$sizeInMB = 100
$buffer = New-Object byte[] (1MB)
$random = New-Object Random

$outputFile = "testfile.zip"
if (Test-Path $outputFile) {
    Remove-Item $outputFile
}

Write-Host "Creating ${sizeInMB}MB test file with random data..."

$stream = [System.IO.File]::OpenWrite($outputFile)
try {
    for ($i = 0; $i -lt $sizeInMB; $i++) {
        $random.NextBytes($buffer)
        $stream.Write($buffer, 0, $buffer.Length)
        if ($i % 10 -eq 0) {
            Write-Host "Progress: $i MB / $sizeInMB MB"
        }
    }
} finally {
    $stream.Close()
}

Write-Host "Test file created: $outputFile"
$fileSize = (Get-Item $outputFile).Length / 1MB
Write-Host "File size: $fileSize MB"
