/* Validation and execution for graphqlcore.c. Depends on gql_base.h and gql_parse.h.
 *
 * Data convention: the data value is a JSON object for the Query root. A field reads the
 * member with the field's name. A value of {"$error": "msg"} becomes a field error. When a
 * field has arguments and the value is an array, elements are filtered where each argument
 * equals the element's property of the same name. A missing field with arguments falls back
 * to the plural member name + "s". */

#define MAX_NEST 32
#define PATH_CAP 128
#define SEEN_MAX 64
#define STEP_MAX 200000

static Wr gErr;
static size_t gErrCount;
static const uint8_t *gQ;
static size_t gQN;
static Op *gOps;
static Frag *gFrags;
static Op *gOp;
static size_t gSteps;

/* Mutations: the root fields of a mutation read their results from gMutRoot (keyed by response
 * key) instead of resolving against the data. Only the root object of the data uses this. */
static int gMutation;
static JN *gMutRoot;
static JN *gRootSrc;

/* message builder, shared by validation and execution */
static char mb[1024];
static size_t mbn;
static void mb_reset(void) { mbn = 0; }
static void mb_n(const char *s, size_t n) {
  for (size_t i = 0; i < n && mbn < sizeof(mb) - 1; i++) mb[mbn++] = s[i];
}
static void mb_s(const char *s) { mb_n(s, slen(s)); }

typedef struct { const char *s; size_t n; size_t idx; int isIdx; } PathEl;
static PathEl gPath[PATH_CAP];
static size_t gPathN;

static void path_push_key(const char *s, size_t n) {
  if (gPathN < PATH_CAP) { gPath[gPathN].s = s; gPath[gPathN].n = n; gPath[gPathN].isIdx = 0; }
  gPathN++;
}
static void path_push_idx(size_t i) {
  if (gPathN < PATH_CAP) { gPath[gPathN].idx = i; gPath[gPathN].isIdx = 1; }
  gPathN++;
}
static void path_pop(void) { if (gPathN) gPathN--; }

static int name_eq(const char *a, size_t an, const char *b, size_t bn) {
  return an == bn && mem_eq(a, b, an);
}

/* Records one error. Locations use the query text; path is the current execution path. */
static void err_raw(const char *s, size_t n, size_t pos, int hasPos) {
  if (gErr.ovf) return;
  if (gErrCount) wr_ch(&gErr, ',');
  gErrCount++;
  wr_cstr(&gErr, "{\"message\":");
  wr_jstr(&gErr, s, n);
  if (hasPos) {
    size_t line = 1, col = 1;
    for (size_t i = 0; i < pos && i < gQN; i++) {
      if (gQ[i] == '\n') { line++; col = 1; } else col++;
    }
    wr_cstr(&gErr, ",\"locations\":[{\"line\":");
    wr_uint(&gErr, line);
    wr_cstr(&gErr, ",\"column\":");
    wr_uint(&gErr, col);
    wr_cstr(&gErr, "}]");
  }
  if (gPathN) {
    size_t cnt = gPathN < PATH_CAP ? gPathN : PATH_CAP;
    wr_cstr(&gErr, ",\"path\":[");
    for (size_t i = 0; i < cnt; i++) {
      if (i) wr_ch(&gErr, ',');
      if (gPath[i].isIdx) wr_uint(&gErr, gPath[i].idx);
      else wr_jstr(&gErr, gPath[i].s, gPath[i].n);
    }
    wr_ch(&gErr, ']');
  }
  wr_ch(&gErr, '}');
}
static void err_mb(size_t pos, int hasPos) { err_raw(mb, mbn, pos, hasPos); }

static Field *find_field(Type *t, const char *n, size_t nl) {
  for (Field *f = t->fields; f; f = f->next)
    if (name_eq(f->name, f->nlen, n, nl)) return f;
  return 0;
}
static Arg *find_arg(Field *f, const char *n, size_t nl) {
  for (Arg *a = f->args; a; a = a->next)
    if (name_eq(a->name, a->nlen, n, nl)) return a;
  return 0;
}
static QArg *find_qarg(Sel *s, const char *n, size_t nl) {
  for (QArg *a = s->args; a; a = a->next)
    if (name_eq(a->name, a->nlen, n, nl)) return a;
  return 0;
}
static VarDef *find_var(const char *n, size_t nl) {
  if (!gOp) return 0;
  for (VarDef *v = gOp->vars; v; v = v->next)
    if (name_eq(v->name, v->nlen, n, nl)) return v;
  return 0;
}
static Frag *find_frag(const char *n, size_t nl) {
  for (Frag *f = gFrags; f; f = f->next)
    if (name_eq(f->name, f->nlen, n, nl)) return f;
  return 0;
}

/* ---------- validation ---------- */

static int literal_ok(const TRef *t, const Val *v) {
  if (v->kind == V_NULL) return !t->nonNull;
  if (name_eq(t->name, t->nlen, "Int", 3)) return v->kind == V_INT;
  if (name_eq(t->name, t->nlen, "Float", 5)) return v->kind == V_INT || v->kind == V_FLOAT;
  if (name_eq(t->name, t->nlen, "String", 6)) return v->kind == V_STR;
  if (name_eq(t->name, t->nlen, "ID", 2)) return v->kind == V_STR || v->kind == V_INT;
  if (name_eq(t->name, t->nlen, "Boolean", 7)) return v->kind == V_BOOL;
  return 1; /* custom scalars accept any literal */
}

static void validate_args(Type *owner, Field *f, Sel *fs) {
  for (QArg *qa = fs->args; qa; qa = qa->next) {
    Arg *d = find_arg(f, qa->name, qa->nlen);
    if (!d) {
      mb_reset();
      mb_s("Unknown argument \""); mb_n(qa->name, qa->nlen);
      mb_s("\" on field \""); mb_n(owner->name, owner->nlen); mb_s("."); mb_n(f->name, f->nlen); mb_s("\".");
      err_mb(qa->pos, 1);
      continue;
    }
    if (qa->v.kind == V_VAR) {
      if (!find_var(qa->v.s, qa->v.n)) {
        mb_reset();
        mb_s("Variable \"$"); mb_n(qa->v.s, qa->v.n); mb_s("\" is not defined.");
        err_mb(qa->pos, 1);
      }
      continue;
    }
    if (!literal_ok(&d->t, &qa->v)) {
      mb_reset();
      mb_s("Argument \""); mb_n(qa->name, qa->nlen);
      mb_s("\" on field \""); mb_n(owner->name, owner->nlen); mb_s("."); mb_n(f->name, f->nlen);
      mb_s("\" has an invalid value.");
      err_mb(qa->pos, 1);
    }
  }
  for (Arg *d = f->args; d; d = d->next) {
    if (!d->t.nonNull || d->hasDef) continue;
    if (find_qarg(fs, d->name, d->nlen)) continue;
    mb_reset();
    mb_s("Field \""); mb_n(owner->name, owner->nlen); mb_s("."); mb_n(f->name, f->nlen);
    mb_s("\" argument \""); mb_n(d->name, d->nlen);
    mb_s("\" of type \""); mb_n(d->t.name, d->t.nlen); mb_s("!\" is required, but it was not provided.");
    err_mb(fs->pos, 1);
  }
}

static void validate_set(Type *owner, Sel *set, int depth) {
  if (depth > MAX_NEST) {
    mb_reset(); mb_s("Document is nested too deeply.");
    err_mb(set ? set->pos : 0, set != 0);
    return;
  }
  for (Sel *s = set; s; s = s->next) {
    if (s->kind == SEL_FIELD) {
      if (name_eq(s->name, s->nlen, "__typename", 10)) {
        if (s->sub) { mb_reset(); mb_s("Field \"__typename\" must not have a selection."); err_mb(s->pos, 1); }
        continue;
      }
      Field *f = find_field(owner, s->name, s->nlen);
      if (!f) {
        mb_reset();
        mb_s("Cannot query field \""); mb_n(s->name, s->nlen);
        mb_s("\" on type \""); mb_n(owner->name, owner->nlen); mb_s("\".");
        err_mb(s->pos, 1);
        continue;
      }
      validate_args(owner, f, s);
      Type *ft = f->t.type;
      if (ft->isScalar) {
        if (s->sub) {
          mb_reset();
          mb_s("Field \""); mb_n(f->name, f->nlen);
          mb_s("\" must not have a selection since type \""); mb_n(ft->name, ft->nlen); mb_s("\" has no subfields.");
          err_mb(s->pos, 1);
        }
      } else if (!s->sub) {
        mb_reset();
        mb_s("Field \""); mb_n(f->name, f->nlen);
        mb_s("\" of type \""); mb_n(ft->name, ft->nlen); mb_s("\" must have a selection of subfields.");
        err_mb(s->pos, 1);
      } else {
        validate_set(ft, s->sub, depth + 1);
      }
    } else if (s->kind == SEL_SPREAD) {
      Frag *fr = find_frag(s->name, s->nlen);
      if (!fr) {
        mb_reset(); mb_s("Unknown fragment \""); mb_n(s->name, s->nlen); mb_s("\".");
        err_mb(s->pos, 1);
      } else if (!name_eq(fr->tc, fr->tclen, owner->name, owner->nlen)) {
        mb_reset();
        mb_s("Fragment \""); mb_n(fr->name, fr->nlen);
        mb_s("\" cannot be spread here, because objects of type \""); mb_n(owner->name, owner->nlen);
        mb_s("\" can never be of type \""); mb_n(fr->tc, fr->tclen); mb_s("\".");
        err_mb(s->pos, 1);
      }
    } else {
      if (s->tc && !name_eq(s->tc, s->tclen, owner->name, owner->nlen)) {
        mb_reset();
        mb_s("Inline fragment on type \""); mb_n(s->tc, s->tclen);
        mb_s("\" cannot be used on type \""); mb_n(owner->name, owner->nlen); mb_s("\".");
        err_mb(s->pos, 1);
        continue;
      }
      validate_set(owner, s->sub, depth + 1);
    }
  }
}

/* Returns 0 when fragment spreads nest too deeply or form a cycle. Spreads are the only
 * recursion that can loop, so depth counts spreads only. */
static int spread_ok(Sel *set, int depth) {
  for (Sel *s = set; s; s = s->next) {
    if (++gSteps > STEP_MAX) return 0;
    if (s->kind == SEL_SPREAD) {
      Frag *fr = find_frag(s->name, s->nlen);
      if (!fr) continue;
      if (depth >= MAX_NEST) return 0;
      if (!spread_ok(fr->sub, depth + 1)) return 0;
    } else if (s->sub) {
      if (!spread_ok(s->sub, depth)) return 0;
    }
  }
  return 1;
}

/* ---------- values ---------- */

static JN *member(JN *o, const char *k, size_t kn) {
  if (!o || o->kind != J_OBJ) return 0;
  for (JN *c = o->first; c; c = c->next)
    if (c->klen == kn && mem_eq(c->key, k, kn)) return c;
  return 0;
}

/* Converts a literal or variable to a JSON node for comparison and defaults. */
static JN *arg_json(const Val *v) {
  JN *x;
  switch (v->kind) {
    case V_VAR: {
      VarDef *d = find_var(v->s, v->n);
      if (d && d->jv) return d->jv;
      return jn_new(J_NULL);
    }
    case V_NULL: return jn_new(J_NULL);
    case V_BOOL:
      x = jn_new(J_BOOL);
      if (x) x->b = v->b;
      return x;
    case V_INT:
    case V_FLOAT:
      x = jn_new(J_NUM);
      if (x) { x->s = v->s; x->n = v->n; }
      return x;
    default: /* V_STR and V_ENUM */
      x = jn_new(J_STR);
      if (x) { x->s = v->s; x->n = v->n; }
      return x;
  }
}

static int match_args(JN *e, QArg *args) {
  for (QArg *a = args; a; a = a->next) {
    JN *want = arg_json(&a->v);
    if (!json_equal(member(e, a->name, a->nlen), want)) return 0;
  }
  return 1;
}

static JN *filter_list(JN *arr, QArg *args, int isList) {
  JN *out = jn_new(J_ARR);
  if (!out) return 0;
  JN **tail = &out->first;
  for (JN *e = arr->first; e; e = e->next) {
    if (!match_args(e, args)) continue;
    JN *c = (JN *)galloc(sizeof(JN));
    if (!c) return 0;
    *c = *e;
    c->next = 0;
    *tail = c;
    tail = &c->next;
    if (!isList) break;
  }
  return isList ? out : out->first;
}

static JN *resolve_field(JN *src, Field *f, Sel *fs) {
  if (!src || src->kind != J_OBJ) return 0;
  JN *v = member(src, f->name, f->nlen);
  if (!v && fs->args && f->nlen < 255) {
    char pl[256];
    memcpy(pl, f->name, f->nlen);
    pl[f->nlen] = 's';
    v = member(src, pl, f->nlen + 1);
  }
  if (v && v->kind == J_ARR && fs->args) return filter_list(v, fs->args, f->t.isList);
  return v;
}

/* ---------- execution ---------- */

typedef struct { const char *s; size_t n; } Key;
typedef struct { int first; Key *seen; size_t nseen; } St;

static int seen_new(St *st, const char *s, size_t n) {
  for (size_t i = 0; i < st->nseen; i++)
    if (name_eq(st->seen[i].s, st->seen[i].n, s, n)) return 0;
  if (st->nseen < SEEN_MAX) { st->seen[st->nseen].s = s; st->seen[st->nseen].n = n; st->nseen++; }
  return 1;
}

static void err_nonnull(Type *owner, Field *f, size_t pos) {
  mb_reset();
  mb_s("Cannot return null for non-nullable field ");
  mb_n(owner->name, owner->nlen); mb_s("."); mb_n(f->name, f->nlen); mb_s(".");
  err_mb(pos, 1);
}

static void err_shape(Type *owner, Field *f, size_t pos) {
  mb_reset();
  mb_s("Field \""); mb_n(owner->name, owner->nlen); mb_s("."); mb_n(f->name, f->nlen);
  mb_s("\" returned a value with the wrong shape.");
  err_mb(pos, 1);
}

/* Nullable parent gets null; non-null parent propagates the null upward. */
static int null_or_fail(Wr *w, const TRef *tr) {
  if (tr->nonNull) return 0;
  wr_cstr(w, "null");
  return 1;
}

static int exec_set(Wr *w, Type *owner, Sel *set, JN *src, int depth);

/* Writes one field value. Returns 0 when the value is null and the field is non-null, so the
 * caller must null the enclosing object. */
static int complete(Wr *w, Type *owner, Field *f, Sel *fs, const TRef *tr, JN *v, int depth) {
  int isNull = !v || v->kind == J_NULL;
  int fromErr = 0;
  if (!isNull && v->kind == J_OBJ) {
    JN *e = member(v, "$error", 6);
    if (e && e->kind == J_STR) {
      err_raw(e->s, e->n, fs->pos, 1);
      isNull = 1;
      fromErr = 1;
    }
  }
  if (isNull) {
    if (tr->nonNull) {
      if (!fromErr) err_nonnull(owner, f, fs->pos);
      return 0;
    }
    wr_cstr(w, "null");
    return 1;
  }
  if (tr->isList) {
    if (v->kind != J_ARR) { err_shape(owner, f, fs->pos); return null_or_fail(w, tr); }
    size_t mark = w->len;
    size_t i = 0;
    wr_ch(w, '[');
    for (JN *e = v->first; e; e = e->next, i++) {
      if (i) wr_ch(w, ',');
      path_push_idx(i);
      TRef it;
      memset(&it, 0, sizeof(it));
      it.nonNull = tr->itemNonNull;
      it.type = tr->type;
      int r = complete(w, owner, f, fs, &it, e, depth + 1);
      path_pop();
      if (!r) { w->len = mark; return null_or_fail(w, tr); }
    }
    wr_ch(w, ']');
    return 1;
  }
  if (tr->type->isScalar) {
    if (v->kind == J_OBJ || v->kind == J_ARR) { err_shape(owner, f, fs->pos); return null_or_fail(w, tr); }
    json_write(w, v);
    return 1;
  }
  if (v->kind != J_OBJ) { err_shape(owner, f, fs->pos); return null_or_fail(w, tr); }
  size_t mark = w->len;
  if (exec_set(w, tr->type, fs->sub, v, depth + 1)) return 1;
  w->len = mark;
  return null_or_fail(w, tr);
}

static int exec_field(Wr *w, Type *owner, Sel *fs, JN *src, int depth) {
  const char *key = fs->alias ? fs->alias : fs->name;
  size_t kl = fs->alias ? fs->alen : fs->nlen;
  wr_jstr(w, key, kl);
  wr_ch(w, ':');
  if (name_eq(fs->name, fs->nlen, "__typename", 10)) {
    wr_jstr(w, owner->name, owner->nlen);
    return 1;
  }
  Field *f = find_field(owner, fs->name, fs->nlen);
  if (!f) return 0; /* validated before execution, so this is unreachable */
  JN *v = (gMutation && src == gRootSrc) ? member(gMutRoot, key, kl) : resolve_field(src, f, fs);
  path_push_key(key, kl);
  int r = complete(w, owner, f, fs, &f->t, v, depth);
  path_pop();
  return r;
}

static int exec_sel(Wr *w, Type *owner, Sel *set, JN *src, int depth, St *st) {
  for (Sel *s = set; s; s = s->next) {
    if (s->kind == SEL_FIELD) {
      const char *key = s->alias ? s->alias : s->name;
      size_t kl = s->alias ? s->alen : s->nlen;
      if (!seen_new(st, key, kl)) continue; /* same response key: first one wins */
      if (!st->first) wr_ch(w, ',');
      st->first = 0;
      if (!exec_field(w, owner, s, src, depth)) return 0;
    } else if (s->kind == SEL_SPREAD) {
      Frag *fr = find_frag(s->name, s->nlen);
      if (fr && !exec_sel(w, owner, fr->sub, src, depth + 1, st)) return 0;
    } else {
      if (!exec_sel(w, owner, s->sub, src, depth + 1, st)) return 0;
    }
  }
  return 1;
}

/* Writes one object. Returns 0 (and rolls back its output) when a non-null field failed. */
static int exec_set(Wr *w, Type *owner, Sel *set, JN *src, int depth) {
  size_t mark = w->len;
  Key seen[SEEN_MAX];
  St st;
  st.first = 1;
  st.seen = seen;
  st.nseen = 0;
  wr_ch(w, '{');
  if (!exec_sel(w, owner, set, src, depth, &st)) { w->len = mark; return 0; }
  wr_ch(w, '}');
  return 1;
}
