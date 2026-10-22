/* Shared state for graphqlcore.c: static buffers, a bump arena, output writers,
 * and a small strict JSON reader. Freestanding C, no libc. */
#include <stdint.h>
#include <stddef.h>

#define IN_MAX   (256u * 1024u)
#define DATA_MAX (2u * 1024u * 1024u)
#define ERR_MAX  (256u * 1024u)
#define RES_MAX  (3u * 1024u * 1024u)
#define HEAP_MAX (24u * 1024u * 1024u)
#define NOPOS    ((size_t)-1)

static uint8_t bufSdl[IN_MAX], bufQuery[IN_MAX], bufVars[IN_MAX], bufOp[IN_MAX];
static uint8_t bufData[DATA_MAX];
static char errMem[ERR_MAX];
static char resMem[RES_MAX];
static __attribute__((aligned(8))) uint8_t heap[HEAP_MAX];
static size_t heapTop;
static int oom;

/* volatile loops keep clang from turning them back into memset/memcpy calls */
__attribute__((used)) void *memset(void *d, int c, size_t n) {
  volatile uint8_t *p = (volatile uint8_t *)d;
  while (n--) *p++ = (uint8_t)c;
  return d;
}
__attribute__((used)) void *memcpy(void *d, const void *s, size_t n) {
  volatile uint8_t *p = (volatile uint8_t *)d;
  const volatile uint8_t *q = (const volatile uint8_t *)s;
  while (n--) *p++ = *q++;
  return d;
}
__attribute__((used)) void *memmove(void *d, const void *s, size_t n) {
  volatile uint8_t *p = (volatile uint8_t *)d;
  const volatile uint8_t *q = (const volatile uint8_t *)s;
  if (p < q) { while (n--) *p++ = *q++; }
  else { p += n; q += n; while (n--) *--p = *--q; }
  return d;
}
static int mem_eq(const char *a, const char *b, size_t n) {
  for (size_t i = 0; i < n; i++) if (a[i] != b[i]) return 0;
  return 1;
}
static size_t slen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }

static void *galloc(size_t n) {
  size_t need = (n + 7u) & ~(size_t)7u;
  if (need > HEAP_MAX - heapTop) { oom = 1; return 0; }
  void *p = &heap[heapTop];
  heapTop += need;
  memset(p, 0, need);
  return p;
}

/* ---------- output writer ---------- */

typedef struct { char *buf; size_t cap; size_t len; int ovf; } Wr;

static void wr_bytes(Wr *w, const char *s, size_t n) {
  if (w->ovf) return;
  if (w->cap - w->len < n) { w->ovf = 1; return; }
  memcpy(w->buf + w->len, s, n);
  w->len += n;
}
static void wr_ch(Wr *w, char c) { wr_bytes(w, &c, 1); }
static void wr_cstr(Wr *w, const char *s) { wr_bytes(w, s, slen(s)); }
static void wr_uint(Wr *w, size_t v) {
  char t[24]; int k = 0;
  do { t[k++] = (char)('0' + v % 10); v /= 10; } while (v);
  while (k) wr_ch(w, t[--k]);
}
static void wr_jstr(Wr *w, const char *s, size_t n) {
  static const char hex[] = "0123456789abcdef";
  wr_ch(w, '"');
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"') wr_bytes(w, "\\\"", 2);
    else if (c == '\\') wr_bytes(w, "\\\\", 2);
    else if (c == '\n') wr_bytes(w, "\\n", 2);
    else if (c == '\r') wr_bytes(w, "\\r", 2);
    else if (c == '\t') wr_bytes(w, "\\t", 2);
    else if (c < 0x20) {
      char u[6] = {'\\', 'u', '0', '0', hex[c >> 4], hex[c & 15]};
      wr_bytes(w, u, 6);
    } else wr_ch(w, (char)c);
  }
  wr_ch(w, '"');
}

/* ---------- JSON values (decoded tree used for variables and data) ---------- */

enum { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ };

typedef struct JN {
  int kind;
  int b;                 /* J_BOOL value */
  const char *s;         /* J_STR: decoded UTF-8; J_NUM: raw text */
  size_t n;
  const char *key;       /* member name when this node is an object member */
  size_t klen;
  struct JN *first;      /* first child (arrays and objects) */
  struct JN *next;       /* next sibling */
} JN;

typedef struct { const uint8_t *p; size_t n; size_t i; int depth; const char *emsg; } JP;

static JN *jp_fail(JP *j, const char *m) { if (!j->emsg) j->emsg = m; return 0; }
static JN *jn_new(int kind) {
  JN *x = (JN *)galloc(sizeof(JN));
  if (x) x->kind = kind;
  return x;
}
static void jp_ws(JP *j) {
  while (j->i < j->n) {
    uint8_t c = j->p[j->i];
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') j->i++;
    else break;
  }
}
static int hexv(uint8_t c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
static size_t utf8_put(uint8_t *o, uint32_t cp) {
  if (cp < 0x80) { o[0] = (uint8_t)cp; return 1; }
  if (cp < 0x800) { o[0] = (uint8_t)(0xC0 | (cp >> 6)); o[1] = (uint8_t)(0x80 | (cp & 63)); return 2; }
  if (cp < 0x10000) {
    o[0] = (uint8_t)(0xE0 | (cp >> 12)); o[1] = (uint8_t)(0x80 | ((cp >> 6) & 63)); o[2] = (uint8_t)(0x80 | (cp & 63));
    return 3;
  }
  o[0] = (uint8_t)(0xF0 | (cp >> 18)); o[1] = (uint8_t)(0x80 | ((cp >> 12) & 63));
  o[2] = (uint8_t)(0x80 | ((cp >> 6) & 63)); o[3] = (uint8_t)(0x80 | (cp & 63));
  return 4;
}

/* Reads 4 hex digits at p[i..i+3]; returns -1 on failure. */
static int jp_hex4(const uint8_t *p, size_t n, size_t i) {
  if (i + 4 > n) return -1;
  int v = 0;
  for (int k = 0; k < 4; k++) {
    int h = hexv(p[i + k]);
    if (h < 0) return -1;
    v = (v << 4) | h;
  }
  return v;
}

/* Decodes the JSON string starting at j->i (which must be a quote). */
static int jp_string(JP *j, const char **out, size_t *outn) {
  const uint8_t *p = j->p;
  size_t start = j->i + 1, i = start;
  while (1) {
    if (i >= j->n) { jp_fail(j, "Unterminated JSON string"); return 0; }
    if (p[i] == '"') break;
    if (p[i] == '\\') i += 2;
    else i++;
  }
  size_t raw = i - start;
  uint8_t *o = (uint8_t *)galloc(raw + 1);
  if (!o) return 0;
  size_t k = 0;
  for (i = start; i < start + raw;) {
    uint8_t c = p[i];
    if (c < 0x20) { jp_fail(j, "Control character in JSON string"); return 0; }
    if (c != '\\') { o[k++] = c; i++; continue; }
    uint8_t e = p[i + 1];
    i += 2;
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
        int cp = jp_hex4(p, start + raw, i);
        if (cp < 0) { jp_fail(j, "Bad \\u escape in JSON string"); return 0; }
        i += 4;
        if (cp >= 0xD800 && cp <= 0xDBFF) {
          int lo = (i + 6 <= start + raw && p[i] == '\\' && p[i + 1] == 'u') ? jp_hex4(p, start + raw, i + 2) : -1;
          if (lo >= 0xDC00 && lo <= 0xDFFF) {
            i += 6;
            cp = 0x10000 + (((cp - 0xD800) << 10) | (lo - 0xDC00));
          } else cp = 0xFFFD;
        } else if (cp >= 0xDC00 && cp <= 0xDFFF) cp = 0xFFFD;
        k += utf8_put(o + k, (uint32_t)cp);
        break;
      }
      default: jp_fail(j, "Bad escape in JSON string"); return 0;
    }
  }
  j->i = start + raw + 1;
  *out = (const char *)o;
  *outn = k;
  return 1;
}

static JN *jp_value(JP *j);

static JN *jp_number(JP *j) {
  const uint8_t *p = j->p;
  size_t s = j->i, i = j->i;
  if (i < j->n && p[i] == '-') i++;
  if (i >= j->n || p[i] < '0' || p[i] > '9') return jp_fail(j, "Bad number in JSON");
  if (p[i] == '0') i++;
  else while (i < j->n && p[i] >= '0' && p[i] <= '9') i++;
  if (i < j->n && p[i] == '.') {
    i++;
    if (i >= j->n || p[i] < '0' || p[i] > '9') return jp_fail(j, "Bad number in JSON");
    while (i < j->n && p[i] >= '0' && p[i] <= '9') i++;
  }
  if (i < j->n && (p[i] == 'e' || p[i] == 'E')) {
    i++;
    if (i < j->n && (p[i] == '+' || p[i] == '-')) i++;
    if (i >= j->n || p[i] < '0' || p[i] > '9') return jp_fail(j, "Bad number in JSON");
    while (i < j->n && p[i] >= '0' && p[i] <= '9') i++;
  }
  JN *x = jn_new(J_NUM);
  if (!x) return 0;
  x->s = (const char *)(p + s);
  x->n = i - s;
  j->i = i;
  return x;
}

static JN *jp_value(JP *j) {
  jp_ws(j);
  if (j->i >= j->n) return jp_fail(j, "Unexpected end of JSON");
  const uint8_t *p = j->p;
  uint8_t c = p[j->i];
  if (c == '{' || c == '[') {
    if (++j->depth > 128) return jp_fail(j, "JSON nested too deeply");
    int isObj = (c == '{');
    JN *x = jn_new(isObj ? J_OBJ : J_ARR);
    if (!x) return 0;
    j->i++;
    jp_ws(j);
    JN *tail = 0;
    if (j->i < j->n && p[j->i] == (isObj ? '}' : ']')) {
      j->i++;
      j->depth--;
      return x;
    }
    while (1) {
      JN *member = 0;
      if (isObj) {
        jp_ws(j);
        if (j->i >= j->n || p[j->i] != '"') return jp_fail(j, "Expected a string key in JSON object");
        const char *k; size_t kn;
        if (!jp_string(j, &k, &kn)) return 0;
        jp_ws(j);
        if (j->i >= j->n || p[j->i] != ':') return jp_fail(j, "Expected : in JSON object");
        j->i++;
        member = jp_value(j);
        if (!member) return 0;
        member->key = k;
        member->klen = kn;
      } else {
        member = jp_value(j);
        if (!member) return 0;
      }
      if (!x->first) x->first = member; else tail->next = member;
      tail = member;
      jp_ws(j);
      if (j->i < j->n && p[j->i] == ',') { j->i++; continue; }
      if (j->i < j->n && p[j->i] == (isObj ? '}' : ']')) { j->i++; break; }
      return jp_fail(j, isObj ? "Expected , or } in JSON object" : "Expected , or ] in JSON array");
    }
    j->depth--;
    return x;
  }
  if (c == '"') {
    JN *x = jn_new(J_STR);
    if (!x) return 0;
    if (!jp_string(j, &x->s, &x->n)) return 0;
    return x;
  }
  if (c == '-' || (c >= '0' && c <= '9')) return jp_number(j);
  if (j->n - j->i >= 4 && mem_eq((const char *)p + j->i, "true", 4)) {
    JN *x = jn_new(J_BOOL); if (!x) return 0;
    x->b = 1; j->i += 4; return x;
  }
  if (j->n - j->i >= 5 && mem_eq((const char *)p + j->i, "false", 5)) {
    JN *x = jn_new(J_BOOL); if (!x) return 0;
    x->b = 0; j->i += 5; return x;
  }
  if (j->n - j->i >= 4 && mem_eq((const char *)p + j->i, "null", 4)) {
    j->i += 4;
    return jn_new(J_NULL);
  }
  return jp_fail(j, "Unexpected character in JSON");
}

/* Parses a whole document. Returns NULL and sets *emsg on failure. */
static JN *json_parse(const uint8_t *p, size_t n, const char **emsg) {
  JP j = {p, n, 0, 0, 0};
  JN *root = jp_value(&j);
  if (root) {
    jp_ws(&j);
    if (j.i != n) root = jp_fail(&j, "Unexpected data after JSON value");
  }
  if (!root) {
    if (oom) j.emsg = "Out of memory";
    *emsg = j.emsg ? j.emsg : "Invalid JSON";
  }
  return root;
}

/* Writes a parsed JSON value back out as JSON. */
static void json_write(Wr *w, const JN *v) {
  if (!v) { wr_cstr(w, "null"); return; }
  switch (v->kind) {
    case J_NULL: wr_cstr(w, "null"); break;
    case J_BOOL: wr_cstr(w, v->b ? "true" : "false"); break;
    case J_NUM: wr_bytes(w, v->s, v->n); break;
    case J_STR: wr_jstr(w, v->s, v->n); break;
    case J_ARR:
    case J_OBJ: {
      int isObj = v->kind == J_OBJ;
      wr_ch(w, isObj ? '{' : '[');
      int first = 1;
      for (const JN *c = v->first; c; c = c->next) {
        if (!first) wr_ch(w, ',');
        first = 0;
        if (isObj) { wr_jstr(w, c->key, c->klen); wr_ch(w, ':'); }
        json_write(w, c);
      }
      wr_ch(w, isObj ? '}' : ']');
      break;
    }
  }
}

/* Structural equality of two JSON values, used for argument filtering. */
static int json_equal(const JN *a, const JN *b) {
  if (!a || !b) return a == b;
  if (a->kind != b->kind) return 0;
  switch (a->kind) {
    case J_NULL: return 1;
    case J_BOOL: return a->b == b->b;
    case J_NUM:
    case J_STR: return a->n == b->n && mem_eq(a->s, b->s, a->n);
    default: return 0; /* lists and objects are never used as filter arguments */
  }
}
