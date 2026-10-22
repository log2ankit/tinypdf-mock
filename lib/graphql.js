'use strict';
// GraphQL executor backed by the WebAssembly core in graphqlcore.wasm.
// Node: loadGraphQLSync() reads the file. Browser: instantiateGraphQL(bytes) is async.
//
// Mutations: the core lists the root calls of a mutation (plan). This module applies each call to
// the data, in order, using the handlers you give (see applyMutation), then runs the selection
// with the results. Writes change `data` in place. Queries never change data.

const fs = require('fs');
const path = require('path');

const enc = new TextEncoder();
const dec = new TextDecoder();

// Handler kinds: insert into a list, update a list item found by "by" (default "id"), or delete one.
function validateMutations(mutations) {
  const out = {};
  Object.keys(mutations || {}).forEach((name) => {
    const h = mutations[name];
    if (!h || typeof h !== 'object') throw new Error('graphql.mutations.' + name + ' must be an object.');
    const kinds = ['insert', 'update', 'delete'].filter((k) => typeof h[k] === 'string' && h[k]);
    if (kinds.length !== 1) throw new Error('graphql.mutations.' + name + ' must set exactly one of insert, update or delete, each naming a list in the data.');
    if (h.defaults !== undefined && (h.defaults === null || typeof h.defaults !== 'object' || Array.isArray(h.defaults))) {
      throw new Error('graphql.mutations.' + name + '.defaults must be an object.');
    }
    out[name] = { kind: kinds[0], list: h[kinds[0]], by: typeof h.by === 'string' && h.by ? h.by : 'id', defaults: h.defaults || {} };
  });
  return out;
}

function listOf(data, name) {
  if (!Array.isArray(data[name])) data[name] = [];
  return data[name];
}

function nextId(list) {
  let n = list.length + 1;
  while (list.some((x) => x && String(x.id) === 'new' + n)) n++;
  return 'new' + n;
}

// Applies one planned mutation call to data. Returns the value of the mutation field.
function applyMutation(data, handlers, call) {
  const h = handlers && handlers[call.field];
  if (!h) {
    return { $error: 'No handler for mutation "' + call.field + '". Add it under "mutations" in the graphql config.' };
  }
  const list = listOf(data, h.list);
  const args = call.args || {};
  if (h.kind === 'insert') {
    const obj = Object.assign({}, h.defaults, args);
    if (obj.id === undefined) obj.id = nextId(list);
    list.push(obj);
    return obj;
  }
  if (h.kind === 'update') {
    if (args[h.by] === undefined) return null;
    const item = list.find((x) => x && String(x[h.by]) === String(args[h.by]));
    if (!item) return null;
    Object.keys(args).forEach((k) => { if (k !== h.by) item[k] = args[k]; });
    return item;
  }
  // delete
  if (args[h.by] === undefined) return false;
  const i = list.findIndex((x) => x && String(x[h.by]) === String(args[h.by]));
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

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

  // One call into the core. fn is "run" or "plan". dataValue is used only by "run".
  function call(fn, schema, query, variables, operationName, dataValue) {
    const sdl = enc.encode(String(schema));
    const q = enc.encode(String(query));
    const vars = variables === undefined ? new Uint8Array(0) : enc.encode(JSON.stringify(variables));
    const data = dataValue === undefined ? new Uint8Array(0) : enc.encode(JSON.stringify(dataValue));
    const op = operationName ? enc.encode(String(operationName)) : new Uint8Array(0);
    if (sdl.length > limits.input || q.length > limits.input || vars.length > limits.input || op.length > limits.input) {
      return { errors: [{ message: 'Input is too large.' }] };
    }
    if (data.length > limits.data) return { errors: [{ message: 'Data is too large.' }] };
    new Uint8Array(mem.buffer, ptrs.sdl, sdl.length).set(sdl);
    new Uint8Array(mem.buffer, ptrs.query, q.length).set(q);
    new Uint8Array(mem.buffer, ptrs.vars, vars.length).set(vars);
    new Uint8Array(mem.buffer, ptrs.data, data.length).set(data);
    new Uint8Array(mem.buffer, ptrs.op, op.length).set(op);
    const n = fn === 'plan'
      ? ex.q_plan(sdl.length, q.length, vars.length, data.length, op.length)
      : ex.q_run(sdl.length, q.length, vars.length, data.length, op.length);
    return JSON.parse(dec.decode(new Uint8Array(mem.buffer, ptrs.out, n).slice()));
  }

  // Validates the document and lists its root calls. Returns { kind, calls } or { errors }.
  function plan(schema, query, opts = {}) {
    return call('plan', schema, query, opts.variables, opts.operationName, undefined);
  }

  // Returns { data?, errors? }. For a mutation, opts.mutations maps each field to a handler and
  // opts.data is changed in place by the writes.
  function execute(schema, query, opts = {}) {
    const p = plan(schema, query, opts);
    if (p.errors) return p;
    if (p.kind === 'mutation') {
      const data = opts.data && typeof opts.data === 'object' && !Array.isArray(opts.data) ? opts.data : {};
      const handlers = validateMutations(opts.mutations || {});
      const results = {};
      p.calls.forEach((c) => { results[c.key] = applyMutation(data, handlers, c); });
      return call('run', schema, query, opts.variables, opts.operationName, { $mutations: results });
    }
    return call('run', schema, query, opts.variables, opts.operationName, opts.data);
  }

  return { execute, plan, limits };
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

module.exports = { loadGraphQLSync, instantiateGraphQL, validateMutations, applyMutation };
