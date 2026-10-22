'use strict';
// GraphQL executor backed by the WebAssembly core in graphqlcore.wasm.
// Node: loadGraphQLSync() reads the file. Browser: instantiateGraphQL(bytes) is async.

const fs = require('fs');
const path = require('path');

const enc = new TextEncoder();
const dec = new TextDecoder();

function wrap(instance) {
  const ex = instance.exports;
  const limits = { input: ex.q_in_max(), data: ex.q_data_max() };
  const ptrs = {
    sdl: ex.q_sdl_ptr(),
    query: ex.q_query_ptr(),
    vars: ex.q_vars_ptr(),
    data: ex.q_data_ptr(),
    op: ex.q_op_ptr(),
    out: ex.q_out_ptr(),
  };
  const mem = ex.memory;

  // Runs one operation. Always returns a plain object: { data?, errors? }.
  function execute(schema, query, opts = {}) {
    const sdl = enc.encode(String(schema));
    const q = enc.encode(String(query));
    const vars = opts.variables === undefined ? new Uint8Array(0) : enc.encode(JSON.stringify(opts.variables));
    const data = opts.data === undefined ? new Uint8Array(0) : enc.encode(JSON.stringify(opts.data));
    const op = opts.operationName ? enc.encode(String(opts.operationName)) : new Uint8Array(0);

    if (sdl.length > limits.input || q.length > limits.input || vars.length > limits.input || op.length > limits.input) {
      return { errors: [{ message: 'Input is too large.' }] };
    }
    if (data.length > limits.data) return { errors: [{ message: 'Data is too large.' }] };

    new Uint8Array(mem.buffer, ptrs.sdl, sdl.length).set(sdl);
    new Uint8Array(mem.buffer, ptrs.query, q.length).set(q);
    new Uint8Array(mem.buffer, ptrs.vars, vars.length).set(vars);
    new Uint8Array(mem.buffer, ptrs.data, data.length).set(data);
    new Uint8Array(mem.buffer, ptrs.op, op.length).set(op);

    const n = ex.q_run(sdl.length, q.length, vars.length, data.length, op.length);
    const text = dec.decode(new Uint8Array(mem.buffer, ptrs.out, n).slice());
    return JSON.parse(text);
  }

  return { execute, limits };
}

// Synchronous (Node). Reads the wasm file next to this module by default.
function loadGraphQLSync(file = path.join(__dirname, 'graphqlcore.wasm')) {
  const module = new WebAssembly.Module(fs.readFileSync(file));
  return wrap(new WebAssembly.Instance(module, {}));
}

// Asynchronous (browser or Node). Pass the wasm bytes.
async function instantiateGraphQL(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return wrap(instance);
}

module.exports = { loadGraphQLSync, instantiateGraphQL };
