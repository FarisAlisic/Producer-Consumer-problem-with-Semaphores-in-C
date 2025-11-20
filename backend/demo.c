#define _GNU_SOURCE
#include <pthread.h>
#include <semaphore.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <string.h>
#include <errno.h>
#include <time.h>
#include <unistd.h>

static int PRODUCERS    = 3;
static int CONSUMERS    = 3;
static int RUN_SEC      = 20;
static int SEED         = 42;
static int SPEED_MS     = 600;
static int PER_CAP      = 20;
static int PROD_BATCH_MAX = 3;
static int CONS_BATCH_MAX = 3;

static inline long long now_ns() {
  // feeds timestamps into events
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec*1000000000LL + ts.tv_nsec;}
static void je(const char* s){
  // Emits JSON instantly to frontend
  fputs(s, stdout); fputc('\n', stdout); fflush(stdout); }

#define MAX_ITEMS 16
#define MAX_ITEM_LEN 32

static int ITEM_COUNT = 4;
static const char *CATALOG_DEFAULT[] = {"milk","bread","eggs","cream"};
static const char **CATALOG = NULL;
static int *INV = NULL;

static const char** parse_items_from_env(int *out_count) {
  // gets item list from ITEM_TYPES env var, or default
  const char *env = getenv("ITEM_TYPES");
  if (!env || !*env) { *out_count = 4; return CATALOG_DEFAULT; }
  static char buf[512];
  strncpy(buf, env, sizeof(buf)-1); buf[sizeof(buf)-1] = 0;
  static const char* stable[MAX_ITEMS];
  int n = 0;
  char *tok = strtok(buf, ",");
  while (tok && n < MAX_ITEMS) {
    while (*tok==' '||*tok=='\t') tok++;
    size_t L = strlen(tok);
    while (L && (tok[L-1]==' '||tok[L-1]=='\t')) tok[--L]=0;
    if (*tok) stable[n++] = tok;
    tok = strtok(NULL, ",");
  }
  if (n == 0) { *out_count = 4; return CATALOG_DEFAULT; }
  *out_count = n;
  return (const char**)stable;
}

static char ***SHELF = NULL;
static int  *in_idx  = NULL;
static int  *out_idx = NULL;

static int find_empty_slot(int item) {
  // finds next empty slot on shelf
  for (int k=0; k<PER_CAP; k++){
    int j = (in_idx[item] + k) % PER_CAP;
    if (strncmp(SHELF[item][j], "empty", MAX_ITEM_LEN) == 0) return j;
  }
  return -1;
}
static int find_filled_slot(int item) {
  // finds next filled slot on shelf
  for (int k=0; k<PER_CAP; k++){
    int j = (out_idx[item] + k) % PER_CAP;
    if (strncmp(SHELF[item][j], "empty", MAX_ITEM_LEN) != 0) return j;
  }
  return -1;
}

// -------------------- visualization semaphores --------------------

typedef struct {
  sem_t *s;
  const char *kind;
  const char *item_name;
  atomic_int count_m;
  atomic_int blocked_m;
  char osname[96];
} VizSem;

static VizSem emptyS[MAX_ITEMS], fullS[MAX_ITEMS], mutexS[MAX_ITEMS];
static atomic_int running = 1;

static inline int clamp0(int x){ return x<0?0:x; }

static void ev_init(VizSem* v){
  // initial state
  char line[256];
  snprintf(line, sizeof(line),
    "{\"t\":\"INIT\",\"ts\":%lld,\"sem\":\"%s\",\"item\":\"%s\",\"count\":%d}",
    now_ns(), v->kind, v->item_name, atomic_load(&v->count_m));
  je(line);
}
static void ev_wait_try(VizSem* v, long thr){
  // attempt to acquire
  char line[256];
  snprintf(line, sizeof(line),
    "{\"t\":\"WAIT_TRY\",\"ts\":%lld,\"thr\":%ld,\"sem\":\"%s\",\"item\":\"%s\",\"count\":%d}",
    now_ns(), thr, v->kind, v->item_name, atomic_load(&v->count_m));
  je(line);
}
static void ev_wait_block(VizSem* v, long thr){
  // blocked
  int b = atomic_fetch_add(&v->blocked_m, 1) + 1;
  b = clamp0(b); atomic_store(&v->blocked_m, b);
  char line[256];
  snprintf(line, sizeof(line),
    "{\"t\":\"WAIT_BLOCK\",\"ts\":%lld,\"thr\":%ld,\"sem\":\"%s\",\"item\":\"%s\",\"blocked\":%d}",
    now_ns(), thr, v->kind, v->item_name, b);
  je(line);
}
static void ev_wait_acquire(VizSem* v, long thr){
  // acquired
  int b = atomic_fetch_sub(&v->blocked_m, 1) - 1;
  b = clamp0(b); atomic_store(&v->blocked_m, b);
  int c = atomic_fetch_sub(&v->count_m, 1) - 1;
  c = clamp0(c); atomic_store(&v->count_m, c);
  char line[256];
  snprintf(line, sizeof(line),
    "{\"t\":\"WAIT_ACQUIRE\",\"ts\":%lld,\"thr\":%ld,\"sem\":\"%s\",\"item\":\"%s\",\"count\":%d,\"blocked\":%d}",
    now_ns(), thr, v->kind, v->item_name, c, b);
  je(line);
}
static void ev_signal(VizSem* v, long thr, int woke){
  // wake waiter if any
  int c;
  if (woke) {
    c = atomic_load(&v->count_m);
  } else {
    c = atomic_fetch_add(&v->count_m, 1) + 1;
    c = clamp0(c); atomic_store(&v->count_m, c);
  }
  char line[256];
  snprintf(line, sizeof(line),
    "{\"t\":\"SIGNAL\",\"ts\":%lld,\"thr\":%ld,\"sem\":\"%s\",\"item\":\"%s\",\"count\":%d,\"woke\":%d}",
    now_ns(), thr, v->kind, v->item_name, c, woke);
  je(line);
}
static void ev_cs(const char* what, long thr, const char* item, int enter){
  // critical section enter/exit
  char line[256];
  snprintf(line, sizeof(line),
    "{\"t\":\"%s\",\"ts\":%lld,\"thr\":%ld,\"item\":\"%s\",\"what\":\"%s\"}",
    enter ? "CS_ENTER" : "CS_EXIT",
    now_ns(), thr, item, what);
  je(line);
}

static void viz_wait(VizSem* v, long thr){
  // wait operation
  ev_wait_try(v, thr);
  if (sem_trywait(v->s) == -1) {
    if (errno == EAGAIN) {
      ev_wait_block(v, thr);
      if (sem_wait(v->s) == -1) { perror("sem_wait"); exit(1); }
    } else { perror("sem_trywait"); exit(1); }
  }
  ev_wait_acquire(v, thr);
}
static void viz_signal(VizSem* v, long thr){
  // signal operation
  int woke = atomic_load(&v->blocked_m) > 0 ? 1 : 0;
  ev_signal(v, thr, woke);
  if (sem_post(v->s) == -1) { perror("sem_post"); exit(1); }
}

// -------------------- named semaphore helpers --------------------

static void open_named(VizSem* v, const char* kind, const char* item_name, unsigned init){
  pid_t pid = getpid();
  snprintf(v->osname, sizeof(v->osname), "/%s_%s_%d", kind, item_name, (int)pid);
  sem_unlink(v->osname);
  v->s = sem_open(v->osname, O_CREAT, 0600, init);
  if (v->s == SEM_FAILED) { perror("sem_open"); exit(1); }
  v->kind = kind;
  v->item_name = item_name;
  atomic_store(&v->count_m, (int)init);
  atomic_store(&v->blocked_m, 0);
}
static void close_named(VizSem* v){
  if (v->s) sem_close(v->s);
  sem_unlink(v->osname);
}

// -------------------- producer & consumer threads --------------------

static void *producer(void *arg){
  long tid = (long)arg;
  while (atomic_load(&running)) {
    int t = rand() % ITEM_COUNT;
    const char* name = CATALOG[t];
    int want = 1 + rand() % PROD_BATCH_MAX;
    if (want > PER_CAP) want = PER_CAP;
    long long t0 = 0;
    if (atomic_load(&emptyS[t].count_m) < want) {
      t0 = now_ns();
      char lineW[256];
      snprintf(lineW, sizeof(lineW),
        "{\"t\":\"SHIPMENT_WAIT\",\"ts\":%lld,\"thr\":%ld,\"item\":\"%s\",\"shelf\":%d,\"want_qty\":%d}",
        t0, tid, name, t, want);
      je(lineW);
    }
    for (int k=0; k<want; k++) viz_wait(&emptyS[t], tid);
    viz_wait(&mutexS[t], tid);
      ev_cs("insert", tid, name, 1);
      int placed = 0;
      int slots_used[PER_CAP];
      for (int i=0;i<PER_CAP;i++) slots_used[i] = -1;
      for (int k=0; k<want; k++){
        int pos = find_empty_slot(t);
        if (pos < 0) break;
        snprintf(SHELF[t][pos], MAX_ITEM_LEN, "%s", name);
        INV[t] += 1;
        in_idx[t] = (pos + 1) % PER_CAP;
        slots_used[placed++] = pos;
      }
      long long wait_ms = 0;
      if (t0) { long long dt = now_ns() - t0; wait_ms = dt / 1000000; }
      {
        char bufslots[512]; bufslots[0]=0;
        strcat(bufslots, "[");
        for (int i=0;i<placed;i++){
          char tmp[16]; snprintf(tmp,sizeof(tmp), "%d%s", slots_used[i], (i+1<placed?",":""));
          strcat(bufslots, tmp);
        }
        strcat(bufslots, "]");
        char line2[768];
        snprintf(line2, sizeof(line2),
          "{\"t\":\"SHIPMENT\",\"ts\":%lld,\"thr\":%ld,\"item\":\"%s\",\"shelf\":%d,\"qty\":%d,\"slots\":%s,\"wait_ms\":%lld}",
          now_ns(), tid, name, t, placed, bufslots, wait_ms);
        je(line2);
      }
    ev_cs("insert", tid, name, 0);
    viz_signal(&mutexS[t], tid);
    for (int k=0; k<placed; k++) viz_signal(&fullS[t], tid);
    usleep(1000 * (SPEED_MS + rand()%SPEED_MS));
  }
  return NULL;
}

static void *consumer(void *arg){
  long tid = (long)arg;
  while (atomic_load(&running)) {
    int t = rand() % ITEM_COUNT;
    const char* name = CATALOG[t];
    int want = 1 + rand() % CONS_BATCH_MAX;
    if (want > PER_CAP) want = PER_CAP;
    long long t0 = 0;
    if (atomic_load(&fullS[t].count_m) < want) {
      t0 = now_ns();
      char lineI[256];
      snprintf(lineI, sizeof(lineI),
        "{\"t\":\"PURCHASE_WAIT\",\"ts\":%lld,\"thr\":%ld,\"item\":\"%s\",\"want_qty\":%d}",
        t0, tid, name, want);
      je(lineI);
    }
    for (int k=0; k<want; k++) viz_wait(&fullS[t], tid);
    viz_wait(&mutexS[t], tid);
      ev_cs("remove", tid, name, 1);
      int taken = 0;
      int slots_got[PER_CAP]; for (int i=0;i<PER_CAP;i++) slots_got[i] = -1;
      for (int k=0; k<want; k++){
        int pos = find_filled_slot(t);
        if (pos < 0) break;
        snprintf(SHELF[t][pos], MAX_ITEM_LEN, "empty");
        INV[t] -= 1;
        out_idx[t] = (pos + 1) % PER_CAP;
        slots_got[taken++] = pos;
      }
      long long wait_ms = 0;
      if (t0) { long long dt = now_ns() - t0; wait_ms = dt / 1000000; }
      {
        char bufslots[512]; bufslots[0]=0;
        strcat(bufslots, "[");
        for (int i=0;i<taken;i++){
          char tmp[16]; snprintf(tmp,sizeof(tmp), "%d%s", slots_got[i], (i+1<taken?",":""));
          strcat(bufslots, tmp);
        }
        strcat(bufslots, "]");
        char line2[768];
        snprintf(line2, sizeof(line2),
          "{\"t\":\"PURCHASE_OK\",\"ts\":%lld,\"thr\":%ld,\"item\":\"%s\",\"shelf\":%d,\"qty\":%d,\"slots\":%s,\"wait_ms\":%lld}",
          now_ns(), tid, name, t, taken, bufslots, wait_ms);
        je(line2);
      }
    ev_cs("remove", tid, name, 0);
    viz_signal(&mutexS[t], tid);
    for (int k=0; k<taken; k++) viz_signal(&emptyS[t], tid);
    usleep(1000 * (SPEED_MS + rand()%SPEED_MS));
  }
  return NULL;
}

static void metric_tick(){
  char line[128];
  snprintf(line, sizeof(line), "{\"t\":\"METRIC\",\"ts\":%lld}", now_ns());
  je(line);
}


int main() {
  setvbuf(stdout, NULL, _IOLBF, 0);
  srand(SEED);

  // items & inventory
  CATALOG = parse_items_from_env(&ITEM_COUNT);
  INV = calloc(ITEM_COUNT, sizeof(int));
  if (!INV) { perror("calloc INV"); return 1; }

  // shelves
  SHELF = malloc(ITEM_COUNT * sizeof(char**));
  in_idx  = calloc(ITEM_COUNT, sizeof(int));
  out_idx = calloc(ITEM_COUNT, sizeof(int));
  if (!SHELF || !in_idx || !out_idx) { perror("alloc idx/shelf"); return 1; }

  for (int i=0;i<ITEM_COUNT;i++){
    SHELF[i] = malloc(PER_CAP * sizeof(char*));
    if (!SHELF[i]) { perror("malloc SHELF[i]"); return 1; }
    for (int j=0;j<PER_CAP;j++){
      SHELF[i][j] = malloc(MAX_ITEM_LEN);
      if (!SHELF[i][j]) { perror("malloc slot"); return 1; }
      snprintf(SHELF[i][j], MAX_ITEM_LEN, "empty");
    }
  }

  // semaphores
  for (int i=0;i<ITEM_COUNT;i++){
    open_named(&emptyS[i], "empty", CATALOG[i], PER_CAP);
    open_named(&fullS[i],  "full",  CATALOG[i], 0);
    open_named(&mutexS[i], "mutex", CATALOG[i], 1);
  }

  for (int i=0;i<ITEM_COUNT;i++){ ev_init(&emptyS[i]); ev_init(&fullS[i]); ev_init(&mutexS[i]); }

  // threads
  pthread_t *p = malloc(sizeof(pthread_t)*PRODUCERS);
  pthread_t *c = malloc(sizeof(pthread_t)*CONSUMERS);
  if (!p || !c) { perror("malloc threads"); return 1; }
  for (long i=0;i<PRODUCERS;i++) pthread_create(&p[i], NULL, producer, (void*)i);
  for (long i=0;i<CONSUMERS;i++) pthread_create(&c[i], NULL, consumer, (void*)(i + PRODUCERS));

  // run loop
  long long end_ns = now_ns() + (long long)RUN_SEC * 1000000000LL;
  while (now_ns() < end_ns) { metric_tick(); usleep(200000); }

  // shutdown
  atomic_store(&running, 0);
  for (int i=0;i<PRODUCERS;i++) pthread_join(p[i], NULL);
  for (int i=0;i<CONSUMERS;i++) pthread_join(c[i], NULL);

  for (int i=0;i<ITEM_COUNT;i++){
    close_named(&emptyS[i]);
    close_named(&fullS[i]);
    close_named(&mutexS[i]);
  }

  for (int i=0;i<ITEM_COUNT;i++){
    for (int j=0;j<PER_CAP;j++) free(SHELF[i][j]);
    free(SHELF[i]);
  }
  free(SHELF); free(INV); free(in_idx); free(out_idx);
  free(p); free(c);
  return 0;
}