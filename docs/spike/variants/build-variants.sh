#!/usr/bin/env bash
set -uo pipefail
S=${SPIKE_DIR:?set SPIKE_DIR to the directory holding core_<variant>/ and env.sh}
. $S/env.sh
for v in "$@"; do
  d=$S/core_$v
  ( cd $d && cargo +stable build --release --target wasm32-unknown-unknown ${FEAT:+--features $FEAT} >$d/build.log 2>&1 ) || { echo "$v: BUILD FAILED"; tail -20 $d/build.log; continue; }
  raw=$d/target/wasm32-unknown-unknown/release/enig_term_core.wasm
  rm -rf $d/pkg; $WASM_BINDGEN --target web --out-dir $d/pkg $raw
  $WASM_OPT ${WOPT:--Oz} --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals --enable-reference-types --enable-multivalue $d/pkg/enig_term_core_bg.wasm -o $d/pkg/opt.wasm
  echo "$v: cargo $(stat -c %s $raw) bindgen $(stat -c %s $d/pkg/enig_term_core_bg.wasm) opt $(stat -c %s $d/pkg/opt.wasm) gz $(gzip -9 -c $d/pkg/opt.wasm | wc -c) gz-unopt $(gzip -9 -c $d/pkg/enig_term_core_bg.wasm | wc -c)"
done
