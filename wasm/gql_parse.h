/* GraphQL lexer and parser for executable documents and for the SDL subset
 * (type / scalar definitions with scalar arguments). Depends on gql_base.h. */

enum { V_NULL, V_BOOL, V_INT, V_FLOAT, V_STR, V_ENUM, V_VAR };
enum { SEL_FIELD, SEL_SPREAD, SEL_INLINE };

typedef struct Val { int kind; int b; const char *s; size_t n; } Val;

typedef struct TRef {
  const char *name; size_t nlen;     /* named type */
  int nonNull;                       /* T! or [..]! */
  int isList;                        /* [T] */
  int itemNonNull;                   /* [T!] */
  struct Type *type;                 /* resolved after SDL parse */
} TRef;

typedef struct Arg {                 /* argument definition in SDL */
  const char *name; size_t nlen;
  TRef t;
  int hasDef; Val def;
  struct Arg *next;
} Arg;

typedef struct Field {               /* field definition in SDL */
  const char *name; size_t nlen;
  TRef t;
  Arg *args;
  struct Field *next;
} Field;

typedef struct Type {
  const char *name; size_t nlen;
  int isScalar;
  Field *fields;
  struct Type *next;
} Type;

typedef struct QArg {                /* argument in an executable document */
  const char *name; size_t nlen;
  Val v;
  size_t pos;
  struct QArg *next;
} QArg;

typedef struct Sel {
  int kind;
  const char *alias; size_t alen;    /* response key override (fields) */
  const char *name; size_t nlen;     /* field name or fragment name */
  const char *tc; size_t tclen;      /* type condition (inline fragments) */
  size_t pos;
  QArg *args;
  struct Sel *sub;                   /* sub selection set */
  struct Sel *next;
} Sel;

typedef struct VarDef {
  const char *name; size_t nlen;
  TRef t;
  int hasDef; Val def;
  size_t pos;
  struct JN *jv;                     /* resolved value for this run, NULL if absent */
  struct VarDef *next;
} VarDef;

typedef struct Frag {
  const char *name; size_t nlen;
  const char *tc; size_t tclen;
  Sel *sub;
  size_t pos;
  struct Frag *next;
} Frag;

typedef struct Op {
  const char *name; size_t nlen;
  VarDef *vars;
  Sel *sub;
  size_t pos;
  struct Op *next;
} Op;

/* ---------- parse error state ---------- */

static const uint8_t *gSrc;          /* source the error refers to */
static size_t gSrcN;
static int gHasErr;
static const char *gErrMsg;
static size_t gErrPos;

/* ---------- lexer ---------- */

enum { T_EOF, T_NAME, T_INT, T_FLOAT, T_STRING, T_SPREAD, T_PUNCT };

typedef struct Tok { int kind; size_t pos; const char *sval; size_t svlen; uint8_t punct; } Tok;
typedef struct Lx { const uint8_t *s; size_t n; size_t i; } Lx;

static Lx gLx;
static Tok gCur;

static void perr(const char *m, size_t pos) {
  if (gHasErr) return;
  gHasErr = 1;
  gErrMsg = m;
  gErrPos = pos;
  gSrc = gLx.s;
  gSrcN = gLx.n;
}
static int is_name_start(uint8_t c) { return c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }
static int is_name_char(uint8_t c) { return is_name_start(c) || (c >= '0' && c <= '9'); }

static int lx_next(Tok *t) {
  Lx *l = &gLx;
  const uint8_t *s = l->s;
  while (l->i < l->n) {
    uint8_t c = s[l->i];
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',') l->i++;
    else if (c == '#') { while (l->i < l->n && s[l->i] != '\n') l->i++; }
    else break;
  }
  t->pos = l->i;
  if (l->i >= l->n) { t->kind = T_EOF; return 1; }
  uint8_t c = s[l->i];
  if (is_name_start(c)) {
    size_t st = l->i;
    while (l->i < l->n && is_name_char(s[l->i])) l->i++;
    t->kind = T_NAME; t->sval = (const char *)s + st; t->svlen = l->i - st;
    return 1;
  }
  if (c == '-' || (c >= '0' && c <= '9')) {
    size_t st = l->i;
    int isFloat = 0;
    if (s[l->i] == '-') l->i++;
    if (l->i >= l->n || s[l->i] < '0' || s[l->i] > '9') { perr("Bad number", st); return 0; }
    if (s[l->i] == '0') l->i++;
    else while (l->i < l->n && s[l->i] >= '0' && s[l->i] <= '9') l->i++;
    if (l->i < l->n && s[l->i] == '.') {
      isFloat = 1; l->i++;
      if (l->i >= l->n || s[l->i] < '0' || s[l->i] > '9') { perr("Bad number", st); return 0; }
      while (l->i < l->n && s[l->i] >= '0' && s[l->i] <= '9') l->i++;
    }
    if (l->i < l->n && (s[l->i] == 'e' || s[l->i] == 'E')) {
      isFloat = 1; l->i++;
      if (l->i < l->n && (s[l->i] == '+' || s[l->i] == '-')) l->i++;
      if (l->i >= l->n || s[l->i] < '0' || s[l->i] > '9') { perr("Bad number", st); return 0; }
      while (l->i < l->n && s[l->i] >= '0' && s[l->i] <= '9') l->i++;
    }
    t->kind = isFloat ? T_FLOAT : T_INT;
    t->sval = (const char *)s + st; t->svlen = l->i - st;
    return 1;
  }
  if (c == '"') {
    if (l->i + 2 < l->n && s[l->i + 1] == '"' && s[l->i + 2] == '"') {
      /* block string: value is the raw text (no indentation stripping) */
      size_t st = l->i + 3, i = st;
      while (i + 2 < l->n && !(s[i] == '"' && s[i + 1] == '"' && s[i + 2] == '"')) i++;
      if (i + 2 >= l->n) { perr("Unterminated block string", t->pos); return 0; }
      t->kind = T_STRING; t->sval = (const char *)s + st; t->svlen = i - st;
      l->i = i + 3;
      return 1;
    }
    size_t st = ++l->i;
    size_t i = st;
    while (1) {
      if (i >= l->n || s[i] == '\n') { perr("Unterminated string", t->pos); return 0; }
      if (s[i] == '"') break;
      if (s[i] == '\\') i += 2; else i++;
    }
    uint8_t *o = (uint8_t *)galloc(i - st + 1);
    if (!o) { perr("Out of memory", t->pos); return 0; }
    size_t k = 0;
    for (size_t j = st; j < i;) {
      uint8_t ch = s[j];
      if (ch != '\\') { o[k++] = ch; j++; continue; }
      uint8_t e = j + 1 < i ? s[j + 1] : 0;
      j += 2;
      switch (e) {
        case '"': o[k++] = '"'; break;
        case '\\': o[k++] = '\\'; break;
        case '/': o[k++] = '/'; break;
        case 'b': o[k++] = '\b'; break;
        case 'f': o[k++] = '\f'; break;
        case 'n': o[k++] = '\n'; break;
        case 'r': o[k++] = '\r'; break;
        case 't': o[k++] = '\t'; break;
        case 'u': {
          int cp = jp_hex4(s, i, j);
          if (cp < 0) { perr("Bad \\u escape in string", t->pos); return 0; }
          j += 4;
          k += utf8_put(o + k, (uint32_t)cp);
          break;
        }
        default: perr("Bad escape in string", t->pos); return 0;
      }
    }
    l->i = i + 1;
    t->kind = T_STRING; t->sval = (const char *)o; t->svlen = k;
    return 1;
  }
  if (c == '.') {
    if (l->i + 2 < l->n && s[l->i + 1] == '.' && s[l->i + 2] == '.') {
      l->i += 3; t->kind = T_SPREAD; return 1;
    }
    perr("Unexpected \".\"", l->i); return 0;
  }
  if (c == '!' || c == '$' || c == '&' || c == '(' || c == ')' || c == ':' || c == '=' ||
      c == '@' || c == '[' || c == ']' || c == '{' || c == '|' || c == '}') {
    l->i++;
    t->kind = T_PUNCT; t->punct = c;
    return 1;
  }
  perr("Unexpected character", l->i);
  return 0;
}

/* ---------- parser helpers ---------- */

static int advance(void) {
  if (gHasErr) return 0;
  return lx_next(&gCur);
}
static int is_p(uint8_t c) { return gCur.kind == T_PUNCT && gCur.punct == c; }
static int is_kw(const char *w) {
  size_t n = slen(w);
  return gCur.kind == T_NAME && gCur.svlen == n && mem_eq(gCur.sval, w, n);
}
static int fail_at(const char *m) { perr(m, gCur.pos); return 0; }
static int expect_p(uint8_t c, const char *m) {
  if (!is_p(c)) return fail_at(m);
  return advance();
}
static int expect_name(const char **s, size_t *n, const char *m) {
  if (gCur.kind != T_NAME) return fail_at(m);
  *s = gCur.sval; *n = gCur.svlen;
  return advance();
}

/* Literal or variable value. Lists and objects are not supported. */
static int parse_value(Val *v, int allowVar) {
  memset(v, 0, sizeof(*v));
  if (is_p('$')) {
    if (!allowVar) return fail_at("Variables are not allowed here");
    if (!advance()) return 0;
    v->kind = V_VAR;
    if (!expect_name(&v->s, &v->n, "Expected a variable name")) return 0;
    return 1;
  }
  switch (gCur.kind) {
    case T_INT: v->kind = V_INT; v->s = gCur.sval; v->n = gCur.svlen; return advance();
    case T_FLOAT: v->kind = V_FLOAT; v->s = gCur.sval; v->n = gCur.svlen; return advance();
    case T_STRING: v->kind = V_STR; v->s = gCur.sval; v->n = gCur.svlen; return advance();
    case T_NAME:
      if (is_kw("true")) { v->kind = V_BOOL; v->b = 1; return advance(); }
      if (is_kw("false")) { v->kind = V_BOOL; v->b = 0; return advance(); }
      if (is_kw("null")) { v->kind = V_NULL; return advance(); }
      v->kind = V_ENUM; v->s = gCur.sval; v->n = gCur.svlen;
      return advance();
    default:
      if (is_p('[') || is_p('{')) return fail_at("List and object values are not supported");
      return fail_at("Expected a value");
  }
}

static int parse_type(TRef *t) {
  memset(t, 0, sizeof(*t));
  if (is_p('[')) {
    if (!advance()) return 0;
    t->isList = 1;
    if (!expect_name(&t->name, &t->nlen, "Expected a type name")) return 0;
    if (is_p('!')) { t->itemNonNull = 1; if (!advance()) return 0; }
    if (!expect_p(']', "Expected ]")) return 0;
  } else {
    if (!expect_name(&t->name, &t->nlen, "Expected a type name")) return 0;
  }
  if (is_p('!')) { t->nonNull = 1; if (!advance()) return 0; }
  return 1;
}

/* ---------- executable documents ---------- */

static Sel *new_sel(void) { return (Sel *)galloc(sizeof(Sel)); }

static Sel *parse_sel_set(void);

static Sel *parse_selection(void) {
  Sel *s = new_sel();
  if (!s) { perr("Out of memory", gCur.pos); return 0; }
  s->pos = gCur.pos;
  if (gCur.kind == T_SPREAD) {
    if (!advance()) return 0;
    if (is_kw("on")) {
      if (!advance()) return 0;
      s->kind = SEL_INLINE;
      if (!expect_name(&s->tc, &s->tclen, "Expected a type name after \"on\"")) return 0;
    } else if (gCur.kind == T_NAME) {
      s->kind = SEL_SPREAD;
      s->name = gCur.sval; s->nlen = gCur.svlen;
      if (!advance()) return 0;
      if (is_p('@')) { fail_at("Directives are not supported"); return 0; }
      return s;
    } else {
      s->kind = SEL_INLINE;
    }
    if (is_p('@')) { fail_at("Directives are not supported"); return 0; }
    s->sub = parse_sel_set();
    return s->sub || gHasErr ? s : 0;
  }
  s->kind = SEL_FIELD;
  if (!expect_name(&s->name, &s->nlen, "Expected a field name")) return 0;
  if (is_p(':')) {
    if (!advance()) return 0;
    s->alias = s->name; s->alen = s->nlen;
    if (!expect_name(&s->name, &s->nlen, "Expected a field name after alias")) return 0;
  }
  if (is_p('(')) {
    if (!advance()) return 0;
    QArg **tail = &s->args;
    while (!is_p(')')) {
      QArg *a = (QArg *)galloc(sizeof(QArg));
      if (!a) { perr("Out of memory", gCur.pos); return 0; }
      a->pos = gCur.pos;
      if (!expect_name(&a->name, &a->nlen, "Expected an argument name")) return 0;
      if (!expect_p(':', "Expected : after argument name")) return 0;
      if (!parse_value(&a->v, 1)) return 0;
      *tail = a; tail = &a->next;
      if (gCur.kind == T_EOF) { fail_at("Unterminated argument list"); return 0; }
    }
    if (!advance()) return 0;
  }
  if (is_p('@')) { fail_at("Directives are not supported"); return 0; }
  if (is_p('{')) {
    s->sub = parse_sel_set();
    if (!s->sub && !gHasErr) fail_at("Empty selection set");
    if (!s->sub) return 0;
  }
  return s;
}

/* Parses "{ selection+ }" and returns the head of the list. */
static Sel *parse_sel_set(void) {
  if (!expect_p('{', "Expected {")) return 0;
  Sel *head = 0, **tail = &head;
  while (!is_p('}')) {
    if (gCur.kind == T_EOF) { fail_at("Unexpected end of document, expected }"); return 0; }
    Sel *s = parse_selection();
    if (!s) return 0;
    *tail = s; tail = &s->next;
  }
  if (!head) { fail_at("Empty selection set"); return 0; }
  if (!advance()) return 0;
  return head;
}

static int parse_var_defs(VarDef **out) {
  VarDef **tail = out;
  if (!advance()) return 0;
  while (!is_p(')')) {
    if (gCur.kind == T_EOF) return fail_at("Unterminated variable list");
    VarDef *v = (VarDef *)galloc(sizeof(VarDef));
    if (!v) { perr("Out of memory", gCur.pos); return 0; }
    v->pos = gCur.pos;
    if (!expect_p('$', "Expected $ before a variable name")) return 0;
    if (!expect_name(&v->name, &v->nlen, "Expected a variable name")) return 0;
    if (!expect_p(':', "Expected : after variable name")) return 0;
    if (!parse_type(&v->t)) return 0;
    if (is_p('=')) {
      if (!advance()) return 0;
      v->hasDef = 1;
      if (!parse_value(&v->def, 0)) return 0;
    }
    *tail = v; tail = &v->next;
  }
  return advance();
}

/* Parses a whole executable document into ops and fragments. */
static int parse_document(Op **opsOut, Frag **fragsOut) {
  Op **opTail = opsOut;
  Frag **fragTail = fragsOut;
  while (gCur.kind != T_EOF) {
    if (is_p('{')) {
      Op *op = (Op *)galloc(sizeof(Op));
      if (!op) { perr("Out of memory", gCur.pos); return 0; }
      op->pos = gCur.pos;
      op->sub = parse_sel_set();
      if (!op->sub) return 0;
      *opTail = op; opTail = &op->next;
    } else if (is_kw("query")) {
      Op *op = (Op *)galloc(sizeof(Op));
      if (!op) { perr("Out of memory", gCur.pos); return 0; }
      op->pos = gCur.pos;
      if (!advance()) return 0;
      if (gCur.kind == T_NAME) {
        op->name = gCur.sval; op->nlen = gCur.svlen;
        if (!advance()) return 0;
      }
      if (is_p('(')) { if (!parse_var_defs(&op->vars)) return 0; }
      if (is_p('@')) { fail_at("Directives are not supported"); return 0; }
      op->sub = parse_sel_set();
      if (!op->sub) return 0;
      *opTail = op; opTail = &op->next;
    } else if (is_kw("mutation") || is_kw("subscription")) {
      fail_at("Only query operations are supported");
      return 0;
    } else if (is_kw("fragment")) {
      Frag *f = (Frag *)galloc(sizeof(Frag));
      if (!f) { perr("Out of memory", gCur.pos); return 0; }
      f->pos = gCur.pos;
      if (!advance()) return 0;
      if (is_kw("on")) { fail_at("Fragment name cannot be \"on\""); return 0; }
      if (!expect_name(&f->name, &f->nlen, "Expected a fragment name")) return 0;
      if (!is_kw("on")) { fail_at("Expected \"on\" in fragment definition"); return 0; }
      if (!advance()) return 0;
      if (!expect_name(&f->tc, &f->tclen, "Expected a type name")) return 0;
      if (is_p('@')) { fail_at("Directives are not supported"); return 0; }
      f->sub = parse_sel_set();
      if (!f->sub) return 0;
      *fragTail = f; fragTail = &f->next;
    } else {
      fail_at("Expected an operation or fragment definition");
      return 0;
    }
  }
  return 1;
}

/* ---------- SDL (type and scalar definitions) ---------- */

static Type *gTypes;

static Type *find_type(const char *s, size_t n) {
  for (Type *t = gTypes; t; t = t->next)
    if (t->nlen == n && mem_eq(t->name, s, n)) return t;
  return 0;
}

static int add_type(const char *s, size_t n, int isScalar, Type **out) {
  if (find_type(s, n)) { perr("Duplicate type definition", gCur.pos); return 0; }
  Type *t = (Type *)galloc(sizeof(Type));
  if (!t) { perr("Out of memory", gCur.pos); return 0; }
  t->name = s; t->nlen = n; t->isScalar = isScalar;
  t->next = gTypes;
  gTypes = t;
  *out = t;
  return 1;
}

static void skip_description(void) {
  if (gCur.kind == T_STRING) advance();
}

static int parse_sdl(void) {
  Type *cur = 0;
  while (gCur.kind != T_EOF) {
    skip_description();
    if (gCur.kind == T_EOF) break;
    if (is_kw("scalar")) {
      if (!advance()) return 0;
      const char *n; size_t nl;
      if (!expect_name(&n, &nl, "Expected a scalar name")) return 0;
      if (!add_type(n, nl, 1, &cur)) return 0;
      continue;
    }
    if (!is_kw("type")) { fail_at("Only type and scalar definitions are supported in the schema"); return 0; }
    if (!advance()) return 0;
    const char *n; size_t nl;
    if (!expect_name(&n, &nl, "Expected a type name")) return 0;
    if (is_kw("implements")) { fail_at("implements is not supported"); return 0; }
    if (!add_type(n, nl, 0, &cur)) return 0;
    if (!expect_p('{', "Expected { after type name")) return 0;
    Field **ftail = &cur->fields;
    while (!is_p('}')) {
      if (gCur.kind == T_EOF) { fail_at("Unterminated type definition"); return 0; }
      skip_description();
      Field *f = (Field *)galloc(sizeof(Field));
      if (!f) { perr("Out of memory", gCur.pos); return 0; }
      if (!expect_name(&f->name, &f->nlen, "Expected a field name")) return 0;
      if (is_p('(')) {
        if (!advance()) return 0;
        Arg **atail = &f->args;
        while (!is_p(')')) {
          if (gCur.kind == T_EOF) { fail_at("Unterminated argument list"); return 0; }
          skip_description();
          Arg *a = (Arg *)galloc(sizeof(Arg));
          if (!a) { perr("Out of memory", gCur.pos); return 0; }
          if (!expect_name(&a->name, &a->nlen, "Expected an argument name")) return 0;
          if (!expect_p(':', "Expected : after argument name")) return 0;
          if (!parse_type(&a->t)) return 0;
          if (a->t.isList) { fail_at("List arguments are not supported"); return 0; }
          if (is_p('=')) {
            if (!advance()) return 0;
            a->hasDef = 1;
            if (!parse_value(&a->def, 0)) return 0;
          }
          *atail = a; atail = &a->next;
        }
        if (!advance()) return 0;
      }
      if (!expect_p(':', "Expected : after field name")) return 0;
      if (!parse_type(&f->t)) return 0;
      if (is_p('@')) { fail_at("Directives are not supported"); return 0; }
      *ftail = f; ftail = &f->next;
    }
    if (!advance()) return 0;
  }
  return 1;
}
