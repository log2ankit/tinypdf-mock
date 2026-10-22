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

static void reset_state(void) {
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
  gMutation = 0;
  gMutRoot = 0;
  gRootSrc = 0;
}

/* Schema, document, operation choice, validation and variables. On failure the errors are
 * already recorded in gErr and the caller returns out_errors_only(). */
static int prepare(uint32_t sdlN, uint32_t qN, uint32_t varsN, uint32_t opN) {
  if (sdlN > IN_MAX || qN > IN_MAX || varsN > IN_MAX || opN > IN_MAX) { plain_errors("Input is too large."); return 0; }
  gQ = bufQuery;
  gQN = qN;

  add_builtin("Int", 3);
  add_builtin("Float", 5);
  add_builtin("String", 6);
  add_builtin("Boolean", 7);
  add_builtin("ID", 2);
  gLx.s = bufSdl;
  gLx.n = sdlN;
  gLx.i = 0;
  if (!advance() || !parse_sdl()) { fail_parse(1); return 0; }
  for (Type *t = gTypes; t; t = t->next) {
    for (Field *f = t->fields; f; f = f->next) {
      f->t.type = find_type(f->t.name, f->t.nlen);
      if (!f->t.type) { mb_reset(); mb_s("Unknown type \""); mb_n(f->t.name, f->t.nlen); mb_s("\" in schema."); err_mb(0, 0); return 0; }
      for (Arg *a = f->args; a; a = a->next) {
        a->t.type = find_type(a->t.name, a->t.nlen);
        if (!a->t.type) { mb_reset(); mb_s("Unknown type \""); mb_n(a->t.name, a->t.nlen); mb_s("\" in schema."); err_mb(0, 0); return 0; }
      }
    }
  }

  gHasErr = 0;
  gLx.s = bufQuery;
  gLx.n = qN;
  gLx.i = 0;
  if (!advance() || !parse_document(&gOps, &gFrags)) { fail_parse(0); return 0; }

  size_t opCount = 0;
  for (Op *o = gOps; o; o = o->next) opCount++;
  if (opCount == 0) { plain_errors("The document has no operation."); return 0; }
  Op *op = 0;
  if (opN == 0) {
    if (opCount > 1) { plain_errors("Must provide an operation name when the document has several operations."); return 0; }
    op = gOps;
  } else {
    for (Op *o = gOps; o; o = o->next)
      if (name_eq(o->name, o->nlen, (const char *)bufOp, opN)) { op = o; break; }
    if (!op) {
      mb_reset(); mb_s("Unknown operation named \""); mb_n((const char *)bufOp, opN); mb_s("\".");
      err_mb(0, 0);
      return 0;
    }
  }
  gOp = op;

  Type *rootT = find_type(op->isMutation ? "Mutation" : "Query", op->isMutation ? 8 : 5);
  if (!rootT || rootT->isScalar) {
    plain_errors(op->isMutation ? "The schema has no Mutation type, so this document cannot run mutations."
                                : "Schema must define an object type named Query.");
    return 0;
  }
  gMutation = op->isMutation;

  for (VarDef *v = op->vars; v; v = v->next) {
    v->t.type = find_type(v->t.name, v->t.nlen);
    if (!v->t.type) { mb_reset(); mb_s("Unknown type \""); mb_n(v->t.name, v->t.nlen); mb_s("\"."); err_mb(v->pos, 1); }
    else if (!v->t.type->isScalar) {
      mb_reset(); mb_s("Variable \"$"); mb_n(v->name, v->nlen); mb_s("\" must be of an input type.");
      err_mb(v->pos, 1);
    }
  }

  if (!op->sub) { plain_errors("The operation has no selection."); return 0; }
  validate_set(rootT, op->sub, 0);
  for (Frag *f = gFrags; f; f = f->next) {
    Type *t = find_type(f->tc, f->tclen);
    if (!t || t->isScalar) {
      mb_reset(); mb_s("Fragment \""); mb_n(f->name, f->nlen); mb_s("\" must be on an object type.");
      err_mb(f->pos, 1);
      continue;
    }
    validate_set(t, f->sub, 0);
  }
  gSteps = 0;
  if (!spread_ok(op->sub, 0)) { mb_reset(); mb_s("Fragment spreads nest too deeply or form a cycle."); err_mb(op->pos, 1); }
  for (Frag *f = gFrags; f; f = f->next) {
    gSteps = 0;
    if (!spread_ok(f->sub, 0)) { mb_reset(); mb_s("Fragment \""); mb_n(f->name, f->nlen); mb_s("\" cannot spread itself."); err_mb(f->pos, 1); }
  }
  if (gErrCount) return 0;

  JN *vars = 0;
  if (varsN) {
    const char *em = 0;
    vars = json_parse(bufVars, varsN, &em);
    if (!vars) { plain_errors(em ? em : "Invalid variables JSON."); return 0; }
    if (vars->kind != J_OBJ && vars->kind != J_NULL) { plain_errors("Variables must be a JSON object."); return 0; }
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
        mb_reset(); mb_s("Variable \"$"); mb_n(v->name, v->nlen);
        mb_s("\" of required type \""); mb_n(v->t.name, v->t.nlen); mb_s("!\" was not provided.");
        err_mb(v->pos, 1);
      }
    }
  }
  return gErrCount == 0;
}

/* Lists the root fields of a mutation (or query) with their arguments, so the host can apply the
 * writes first. {"kind":"mutation"|"query","calls":[{"key","field","args":{...}}]} */
typedef struct { Wr *w; St st; } PlanSt;

static void plan_sel(PlanSt *p, Sel *set, int depth) {
  for (Sel *s = set; s; s = s->next) {
    if (depth > MAX_NEST) return;
    if (s->kind == SEL_FIELD) {
      if (name_eq(s->name, s->nlen, "__typename", 10)) continue;
      const char *key = s->alias ? s->alias : s->name;
      size_t kl = s->alias ? s->alen : s->nlen;
      if (!seen_new(&p->st, key, kl)) continue;
      if (!p->st.first) wr_ch(p->w, ',');
      p->st.first = 0;
      wr_cstr(p->w, "{\"key\":");
      wr_jstr(p->w, key, kl);
      wr_cstr(p->w, ",\"field\":");
      wr_jstr(p->w, s->name, s->nlen);
      wr_cstr(p->w, ",\"args\":{");
      int first = 1;
      for (QArg *a = s->args; a; a = a->next) {
        if (!first) wr_ch(p->w, ',');
        first = 0;
        wr_jstr(p->w, a->name, a->nlen);
        wr_ch(p->w, ':');
        json_write(p->w, arg_json(&a->v));
      }
      wr_cstr(p->w, "}}");
    } else if (s->kind == SEL_SPREAD) {
      Frag *fr = find_frag(s->name, s->nlen);
      if (fr) plan_sel(p, fr->sub, depth + 1);
    } else {
      plan_sel(p, s->sub, depth + 1);
    }
  }
}

/* Writes the plan into resMem and returns its length. */
static uint32_t write_plan(void) {
  Wr w = {resMem, RES_MAX, 0, 0};
  wr_cstr(&w, "{\"kind\":\"");
  wr_cstr(&w, gMutation ? "mutation" : "query");
  wr_cstr(&w, "\",\"calls\":[");
  if (gMutation) {
    PlanSt p;
    p.w = &w;
    p.st.first = 1;
    p.st.nseen = 0;
    Key seen[SEEN_MAX];
    p.st.seen = seen;
    plan_sel(&p, gOp->sub, 0);
  }
  wr_cstr(&w, "]}");
  if (w.ovf) return out_fallback();
  return (uint32_t)w.len;
}

/* Runs one operation. Returns the output length; the JSON text is at q_out_ptr(). A mutation
 * takes its results from data.$mutations, keyed by response key. The host applies the writes
 * and fills that object in (see lib/graphql.js). */
__attribute__((export_name("q_run")))
uint32_t q_run(uint32_t sdlN, uint32_t qN, uint32_t varsN, uint32_t dataN, uint32_t opN) {
  reset_state();
  if (dataN > DATA_MAX) return fail_plain("Data is too large.");
  if (!prepare(sdlN, qN, varsN, opN)) return out_errors_only();
  Type *rootT = find_type(gMutation ? "Mutation" : "Query", gMutation ? 8 : 5);

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
  if (gMutation) {
    gRootSrc = root;
    gMutRoot = member(root, "$mutations", 10);
    if (!gMutRoot) gMutRoot = jn_new(J_OBJ);
    if (!gMutRoot) return out_fallback();
  }

  Wr w = {resMem, RES_MAX, 0, 0};
  wr_cstr(&w, "{\"data\":");
  if (!exec_set(&w, rootT, gOp->sub, root, 0)) wr_cstr(&w, "null");
  if (gErrCount) {
    wr_cstr(&w, ",\"errors\":[");
    wr_bytes(&w, errMem, gErr.len);
    wr_ch(&w, ']');
  }
  wr_ch(&w, '}');
  if (w.ovf || gErr.ovf || oom) return out_fallback();
  return (uint32_t)w.len;
}

/* Validates and lists the root calls of an operation, without running it. */
__attribute__((export_name("q_plan")))
uint32_t q_plan(uint32_t sdlN, uint32_t qN, uint32_t varsN, uint32_t dataN, uint32_t opN) {
  (void)dataN;
  reset_state();
  if (!prepare(sdlN, qN, varsN, opN)) return out_errors_only();
  return write_plan();
}
