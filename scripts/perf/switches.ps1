# Each Chromium/V8 switch the research suggested, two quick benchmark runs each (startup, memory with the long
# chat open), against the same build with none. In the Windows copy: powershell -File scripts/perf/switches.ps1
$variants = @(
  '',
  '--enable-features=SmallerInterestArea',
  '--force-gpu-mem-available-mb=64',
  '--enable-low-end-device-mode',
  '--gpu-program-cache-size-kb=1024',
  '--use-angle=d3d11-warp',
  '--js-flags=--max-semi-space-size=1',
  '--disable-features=PartitionAllocLargeEmptySlotSpanRing,PartitionAllocAdjustSizeWhenInForeground,PartitionAllocLargeThreadCacheSize',
  ''
)
$env:BENCH_QUICK = '1'
$env:BENCH_RUNS = '2'
$env:BENCH_KEEP = '1'
foreach ($v in $variants) {
  $env:BENCH_ARGS = $v
  "== [$v]"
  node scripts/perf/bench.mjs 2>&1 | Select-String -Pattern '^(startup|memory after)'
}
