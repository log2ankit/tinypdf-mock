/* GraphQL core for tinypdf-mock: parses an SDL schema and a query document, validates,
 * and executes against a JSON data value. Freestanding C compiled to WebAssembly.
 * Build with wasm/build.sh. The JS side is lib/graphql.js. */

#include "gql_base.h"
#include "gql_parse.h"
#include "gql_exec.h"

static void plain_errors(const char *m) {
  mb_reset();
  mb_s(m);
  err_mb(0, 0);
}

static uint32_t out_fallback(void) {
  Wr o = {resMem, RES_MAX, 0, 0};
  wr_cstr(&o, "{\"data\":null,\"errors\":[{\"message\":\"Response is too large or memory ran out.\"}]}");
  return (uint32_t)o.len;
}

/* {"errors":[...]} with no data, used for schema, syntax, validation and input errors. */
static uint32_t out_errors_only(void) {
  Wr o = {resMem, RES_MAX, 0, 0};
  wr_cstr(&o, "{\"errors\":[");
  wr_bytes(&o, errMem, gErr.len);
  wr_cstr(&o, "]}");
  if (o.ovf || gErr.ovf) return out_fallback();
  return (uint32_t)o.len;
}

static uint32_t fail_plain(const char *m) {
  plain_errors(m);
  return out_errors_only();
}

static uint32_t fail_parse(int isSchema) {
  if (!gHasErr) return fail_plain(oom ? "Out of memory." : (isSchema ? "Schema is invalid." : "Syntax error."));
  if (isSchema) { /* no location: the text refers to the schema */
    mb_reset();
    mb_s("Invalid schema: ");
    mb_s(gErrMsg);
    err_mb(0, 0);
  } else {
    err_raw(gErrMsg, slen(gErrMsg), gErrPos, 1);
  }
  return out_errors_only();
}

static void add_builtin(const char *n, size_t l) {
  Type *t = 0;
  add_type(n, l, 1, &t);
}

/* ---------- exported buffers ---------- */

__attribute__((export_name("q_sdl_ptr"))) uint8_t *q_sdl_ptr(void) { return bufSdl; }
__attribute__((export_name("q_query_ptr"))) uint8_t *q_query_ptr(void) { return bufQuery; }
__attribute__((export_name("q_vars_ptr"))) uint8_t *q_vars_ptr(void) { return bufVars; }
__attribute__((export_name("q_data_ptr"))) uint8_t *q_data_ptr(void) { return bufData; }
__attribute__((export_name("q_op_ptr"))) uint8_t *q_op_ptr(void) { return bufOp; }
__attribute__((export_name("q_out_ptr"))) uint8_t *q_out_ptr(void) { return (uint8_t *)resMem; }
__attribute__((export_name("q_in_max"))) uint32_t q_in_max(void) { return IN_MAX; }
__attribute__((export_name("q_data_max"))) uint32_t q_data_max(void) { return DATA_MAX; }

/* Runs one operation. Returns the output length; the JSON text is at q_out_ptr(). */
__attribute__((export_name("q_run")))
uint32_t q_run(uint32_t sdlN, uint32_t qN, uint32_t varsN, uint32_t dataN, uint32_t opN) {
  heapTop = 0;
  oom = 0;
  gErr.buf = errMem;
  gErr.cap = ERR_MAX;
  gErr.len = 0;
  gErr.ovf = 0;
  gErrCount = 0;
  gPathN = 0;
  gTypes = 0;
  gOps = 0;
  gFrags = 0;
  gOp = 0;
  gHasErr = 0;
  gErrMsg = 0;
  gSteps = 0;

  if (sdlN > IN_MAX || qN > IN_MAX || varsN > IN_MAX || dataN > DATA_MAX || opN > IN_MAX)
    return fail_plain("Input is too large.");
  gQ = bufQuery;
  gQN = qN;

  /* schema */
  add_builtin("Int", 3);
  add_builtin("Float", 5);
  add_builtin("String", 6);
  add_builtin("Boolean", 7);
  add_builtin("ID", 2);
  gLx.s = bufSdl;
  gLx.n = sdlN;
  gLx.i = 0;
  if (!advance() || !parse_sdl()) return fail_parse(1);
  for (Type *t = gTypes; t; t = t->next) {
    for (Field *f = t->fields; f; f = f->next) {
      f->t.type = find_type(f->t.name, f->t.nlen);
      if (!f->t.type) {
        mb_reset();
        mb_s("Unknown type \""); mb_n(f->t.name, f->t.nlen); mb_s("\" in schema.");
        err_mb(0, 0);
        return out_errors_only();
      }
      for (Arg *a = f->args; a; a = a->next) {
        a->t.type = find_type(a->t.name, a->t.nlen);
        if (!a->t.type) {
          mb_reset();
          mb_s("Unknown type \""); mb_n(a->t.name, a->t.nlen); mb_s("\" in schema.");
          err_mb(0, 0);
          return out_errors_only();
        }
      }
    }
  }
  Type *queryT = find_type("Query", 5);
  if (!queryT || queryT->isScalar) return fail_plain("Schema must define an object type named Query.");

  /* document */
  gHasErr = 0;
  gLx.s = bufQuery;
  gLx.n = qN;
  gLx.i = 0;
  if (!advance() || !parse_document(&gOps, &gFrags)) return fail_parse(0);

  size_t opCount = 0;
  for (Op *o = gOps; o; o = o->next) opCount++;
  if (opCount == 0) return fail_plain("The document has no operation.");
  Op *op = 0;
  if (opN == 0) {
    if (opCount > 1) return fail_plain("Must provide an operation name when the document has several operations.");
    op = gOps;
  } else {
    for (Op *o = gOps; o; o = o->next)
      if (name_eq(o->name, o->nlen, (const char *)bufOp, opN)) { op = o; break; }
    if (!op) {
      mb_reset();
      mb_s("Unknown operation named \""); mb_n((const char *)bufOp, opN); mb_s("\".");
      err_mb(0, 0);
      return out_errors_only();
    }
  }
  gOp = op;

  for (VarDef *v = op->vars; v; v = v->next) {
    v->t.type = find_type(v->t.name, v->t.nlen);
    if (!v->t.type) {
      mb_reset();
      mb_s("Unknown type \""); mb_n(v->t.name, v->t.nlen); mb_s("\".");
      err_mb(v->pos, 1);
    } else if (!v->t.type->isScalar) {
      mb_reset();
      mb_s("Variable \"$"); mb_n(v->name, v->nlen); mb_s("\" must be of an input type.");
      err_mb(v->pos, 1);
    }
  }

  /* validation */
  if (!op->sub) return fail_plain("The operation has no selection.");
  validate_set(queryT, op->sub, 0);
  for (Frag *f = gFrags; f; f = f->next) {
    Type *t = find_type(f->tc, f->tclen);
    if (!t || t->isScalar) {
      mb_reset();
      mb_s("Fragment \""); mb_n(f->name, f->nlen); mb_s("\" must be on an object type.");
      err_mb(f->pos, 1);
      continue;
    }
    validate_set(t, f->sub, 0);
  }
  gSteps = 0;
  if (!spread_ok(op->sub, 0)) {
    mb_reset(); mb_s("Fragment spreads nest too deeply or form a cycle.");
    err_mb(op->pos, 1);
  }
  for (Frag *f = gFrags; f; f = f->next) {
    gSteps = 0;
    if (!spread_ok(f->sub, 0)) {
      mb_reset(); mb_s("Fragment \""); mb_n(f->name, f->nlen); mb_s("\" cannot spread itself.");
      err_mb(f->pos, 1);
    }
  }
  if (gErrCount) return out_errors_only();

  /* variables */
  JN *vars = 0;
  if (varsN) {
    const char *em = 0;
    vars = json_parse(bufVars, varsN, &em);
    if (!vars) return fail_plain(em ? em : "Invalid variables JSON.");
    if (vars->kind != J_OBJ && vars->kind != J_NULL) return fail_plain("Variables must be a JSON object.");
  }
  for (VarDef *v = op->vars; v; v = v->next) {
    JN *m = (vars && vars->kind == J_OBJ) ? member(vars, v->name, v->nlen) : 0;
    if (m && m->kind != J_NULL) {
      v->jv = m;
    } else if (v->hasDef) {
      v->jv = arg_json(&v->def);
    } else {
      v->jv = 0;
      if (v->t.nonNull) {
        mb_reset();
        mb_s("Variable \"$"); mb_n(v->name, v->nlen);
        mb_s("\" of required type \""); mb_n(v->t.name, v->t.nlen); mb_s("!\" was not provided.");
        err_mb(v->pos, 1);
      }
    }
  }
  if (gErrCount) return out_errors_only();

  /* data root */
  JN *root = 0;
  if (dataN) {
    const char *em = 0;
    root = json_parse(bufData, dataN, &em);
    if (!root) return fail_plain(em ? em : "Invalid data JSON.");
    if (root->kind != J_OBJ) return fail_plain("The data value must be a JSON object.");
  } else {
    root = jn_new(J_OBJ);
  }
  if (!root) return out_fallback();

  /* execution */
  Wr w = {resMem, RES_MAX, 0, 0};
  wr_cstr(&w, "{\"data\":");
  if (!exec_set(&w, queryT, op->sub, root, 0)) wr_cstr(&w, "null");
  if (gErrCount) {
    wr_cstr(&w, ",\"errors\":[");
    wr_bytes(&w, errMem, gErr.len);
    wr_ch(&w, ']');
  }
  wr_ch(&w, '}');
  if (w.ovf || gErr.ovf || oom) return out_fallback();
  return (uint32_t)w.len;
}
