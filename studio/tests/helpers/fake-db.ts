// fake-db.ts — a tiny in-memory stand-in for the Prisma client.
//
// Why: the real `@prisma/client` cannot be generated in a sandbox without
// network access to binaries.prisma.sh. The engine tests still deserve to run
// end-to-end (waves, events, step rows), so this module implements the small
// slice of the Prisma API the agentic engine actually uses.
//
// It supports: create / createMany / findUnique / findFirst / findMany /
// update / updateMany / upsert / delete / deleteMany / count, with `where`
// equality, `in`, `gt`, `gte`, `lt`, `lte`, `not`, `contains`, AND/OR,
// `orderBy` (single key or array), `take` and `data` with `{increment}`.
//
// NOT a general SQL engine — unknown operators simply never match.

export type Row = Record<string, unknown>;

interface Where {
  [key: string]: unknown;
}

let idCounter = 0;
function nextId(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}_${String(idCounter).padStart(6, '0')}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function compare(fieldValue: unknown, op: string, value: unknown): boolean {
  switch (op) {
    case 'equals':
      return fieldValue === value;
    case 'not':
      return fieldValue !== value;
    case 'in':
      return Array.isArray(value) && value.includes(fieldValue);
    case 'notIn':
      return Array.isArray(value) && !value.includes(fieldValue);
    case 'gt':
      return (fieldValue as number) > (value as number);
    case 'gte':
      return (fieldValue as number) >= (value as number);
    case 'lt':
      return (fieldValue as number) < (value as number);
    case 'lte':
      return (fieldValue as number) <= (value as number);
    case 'contains':
      return typeof fieldValue === 'string' && fieldValue.includes(String(value));
    case 'startsWith':
      return typeof fieldValue === 'string' && fieldValue.startsWith(String(value));
    default:
      return false;
  }
}

/** Does `row` match the Prisma `where` object? */
export function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (key === 'AND') {
      const list = Array.isArray(condition) ? condition : [condition];
      if (!list.every((w) => matches(row, w as Where))) return false;
      continue;
    }
    if (key === 'OR') {
      const list = Array.isArray(condition) ? condition : [condition];
      if (!list.some((w) => matches(row, w as Where))) return false;
      continue;
    }
    if (key === 'NOT') {
      const list = Array.isArray(condition) ? condition : [condition];
      if (list.some((w) => matches(row, w as Where))) return false;
      continue;
    }
    const fieldValue = row[key];
    if (isPlainObject(condition)) {
      const operators = Object.entries(condition);
      // `{ in: [...] }`, `{ gt: n }`, ... — every operator must hold
      if (operators.some(([op]) => ['equals', 'not', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith'].includes(op))) {
        if (!operators.every(([op, value]) => compare(fieldValue, op, value))) return false;
        continue;
      }
    }
    if (fieldValue instanceof Date && condition instanceof Date) {
      if (fieldValue.getTime() !== condition.getTime()) return false;
      continue;
    }
    if (fieldValue !== condition) return false;
  }
  return true;
}

type OrderBy = Record<string, 'asc' | 'desc'> | Record<string, 'asc' | 'desc'>[] | undefined;

function sortRows(rows: Row[], orderBy: OrderBy): Row[] {
  if (!orderBy) return rows;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [field, dir] of Object.entries(spec)) {
        const av = a[field];
        const bv = b[field];
        if (av === bv) continue;
        const numeric = typeof av === 'number' && typeof bv === 'number';
        const cmp = numeric
          ? (av as number) - (bv as number)
          : String(av) < String(bv)
            ? -1
            : 1;
        return dir === 'desc' ? -cmp : cmp;
      }
    }
    return 0;
  });
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (isPlainObject(value)) {
      const record = value as Record<string, unknown>;
      if (typeof record.increment === 'number') {
        row[key] = Number(row[key] ?? 0) + record.increment;
        continue;
      }
      if (typeof record.decrement === 'number') {
        row[key] = Number(row[key] ?? 0) - record.decrement;
        continue;
      }
      if ('set' in record) {
        row[key] = record.set;
        continue;
      }
      // nested relation write (e.g. { create: ... }) — not modelled
      continue;
    }
    row[key] = value;
  }
}

export interface TableDefaults {
  [field: string]: unknown;
}

/** One fake Prisma model. */
export class FakeModel {
  rows: Row[] = [];
  constructor(
    public name: string,
    private defaults: TableDefaults = {},
    private timestamped = true
  ) {}

  private normalize(data: Row): Row {
    const now = new Date();
    const row: Row = {
      id: nextId(this.name),
      ...(this.timestamped ? { createdAt: now, updatedAt: now } : {}),
      ...this.defaults,
      ...data,
    };
    for (const [key, value] of Object.entries(this.defaults)) {
      if (typeof value === 'function') row[key] = (value as () => unknown)();
    }
    if (row.createdAt === undefined && this.timestamped) row.createdAt = now;
    if (row.updatedAt === undefined && this.timestamped) row.updatedAt = now;
    return row;
  }

  async create({ data }: { data: Row }): Promise<Row> {
    const row = this.normalize(data);
    this.rows.push(row);
    return { ...row };
  }

  async createMany({ data }: { data: Row[] }): Promise<{ count: number }> {
    for (const entry of data) this.rows.push(this.normalize(entry));
    return { count: data.length };
  }

  async findUnique({ where, select }: { where: Where; select?: unknown }): Promise<Row | null> {
    void select;
    const found = this.rows.find((r) => matches(r, where));
    return found ? { ...found } : null;
  }

  async findFirst({
    where,
    orderBy,
  }: {
    where?: Where;
    orderBy?: OrderBy;
    select?: unknown;
  } = {}): Promise<Row | null> {
    const list = sortRows(
      this.rows.filter((r) => matches(r, where)),
      orderBy
    );
    return list.length ? { ...list[0] } : null;
  }

  async findMany({
    where,
    orderBy,
    take,
    skip,
  }: {
    where?: Where;
    orderBy?: OrderBy;
    take?: number;
    skip?: number;
    select?: unknown;
  } = {}): Promise<Row[]> {
    let list = sortRows(
      this.rows.filter((r) => matches(r, where)),
      orderBy
    );
    if (skip) list = list.slice(skip);
    if (typeof take === 'number') list = list.slice(0, take);
    return list.map((r) => ({ ...r }));
  }

  async update({ where, data }: { where: Where; data: Row }): Promise<Row> {
    const row = this.rows.find((r) => matches(r, where));
    if (!row) {
      const error = new Error(`${this.name}.update — record not found`);
      (error as Error & { code?: string }).code = 'P2025';
      throw error;
    }
    applyData(row, data);
    if (this.timestamped) row.updatedAt = new Date();
    return { ...row };
  }

  async updateMany({ where, data }: { where?: Where; data: Row }): Promise<{ count: number }> {
    const list = this.rows.filter((r) => matches(r, where));
    for (const row of list) {
      applyData(row, data);
      if (this.timestamped) row.updatedAt = new Date();
    }
    return { count: list.length };
  }

  async upsert({
    where,
    create,
    update,
  }: {
    where: Where;
    create: Row;
    update: Row;
  }): Promise<Row> {
    const row = this.rows.find((r) => matches(r, where));
    if (row) {
      applyData(row, update);
      if (this.timestamped) row.updatedAt = new Date();
      return { ...row };
    }
    const created = this.normalize(create);
    this.rows.push(created);
    return { ...created };
  }

  async delete({ where }: { where: Where }): Promise<Row> {
    const index = this.rows.findIndex((r) => matches(r, where));
    if (index === -1) {
      const error = new Error(`${this.name}.delete — record not found`);
      (error as Error & { code?: string }).code = 'P2025';
      throw error;
    }
    const [removed] = this.rows.splice(index, 1);
    return { ...removed };
  }

  async deleteMany({ where }: { where?: Where } = {}): Promise<{ count: number }> {
    const keep: Row[] = [];
    let count = 0;
    for (const row of this.rows) {
      if (matches(row, where)) count++;
      else keep.push(row);
    }
    this.rows = keep;
    return { count };
  }

  async count({ where }: { where?: Where } = {}): Promise<number> {
    return this.rows.filter((r) => matches(r, where)).length;
  }
}

/** An in-memory prisma-shaped client with only the models the engine touches. */
export function createFakeDb() {
  const agenticTask = new FakeModel('task', {
    status: 'planning',
    plan: '',
    currentStep: 0,
    report: null,
    error: null,
    workspacePath: '',
    provider: 'zai',
    model: 'glm-4.6',
    events: '[]',
    pendingCommand: null,
    agentConfig: '',
    projectRoot: '',
    conversationId: '',
    eventSeq: 0,
    messageSeq: 0,
    retriesUsed: 0,
    startedAt: null,
    goalId: '',
    planGaps: '[]',
    blockedReason: '',
    mode: '',
  });

  const agenticStep = new FakeModel('step', {
    kind: 'implement',
    description: '',
    status: 'pending',
    attempts: 0,
    logs: '[]',
    filesChanged: '[]',
    commands: '[]',
    testResult: null,
    reviewVerdict: null,
  });

  const agentEvent = new FakeModel('event', {
    stepIndex: null,
    payload: '{}',
  });

  const agentMessage = new FakeModel('message', {
    conversationId: '',
    seq: 0,
    fromAgent: '',
    toAgent: '',
    type: 'task',
    correlationId: '',
    content: '',
    provider: null,
    model: null,
    metadata: null,
  });

  const memoryEntry = new FakeModel('memory', {
    scope: 'user',
    key: '',
    content: '',
  });

  const auditLog = new FakeModel('audit', {
    actor: 'system',
    agentId: '',
    taskId: '',
    action: '',
    category: 'general',
    approval: 'auto',
    details: '{}',
    ip: '',
    result: '',
  });

  const notification = new FakeModel('notification', {
    kind: 'info',
    title: '',
    body: '',
    read: false,
    taskId: '',
  });

  const modelPreference = new FakeModel('modelPref', {}, false);
  const providerConfig = new FakeModel('providerConfig', { enabled: false }, false);
  const studioSetting = new FakeModel('setting', { value: '' }, false);
  const proactiveState = new FakeModel('proactiveState', {}, false);
  const knowledgeChunk = new FakeModel('knowledgeChunk', {}, false);

  const db = {
    agenticTask,
    agenticStep,
    agentEvent,
    agentMessage,
    memoryEntry,
    auditLog,
    notification,
    modelPreference,
    providerConfig,
    studioSetting,
    proactiveState,
    knowledgeChunk,
    async $transaction<T>(fn: (client: unknown) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };

  return db;
}

export type FakeDb = ReturnType<typeof createFakeDb>;
