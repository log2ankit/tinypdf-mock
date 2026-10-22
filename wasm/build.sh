#!/usr/bin/env bash
# Builds ../lib/graphqlcore.wasm from graphqlcore.c with plain clang + wasm-ld (no Emscripten).
# Needs clang >= 14 with the wasm32 target.
set -euo pipefail
cd "$(dirname "$0")"
clang --target=wasm32 -std=c11 -O2 -ffreestanding -fno-builtin -nostdlib -mbulk-memory -fvisibility=hidden \
  -Wall -Wextra -Wno-unused-parameter -Wno-sign-compare -Wno-parentheses -Wno-unused-function \
  -Wl,--no-entry -Wl,--strip-all -Wl,-z,stack-size=1048576 \
  -Wl,--initial-memory=41943040 -Wl,--max-memory=4294967296 \
  -o ../lib/graphqlcore.wasm graphqlcore.c
ls -l ../lib/graphqlcore.wasm
