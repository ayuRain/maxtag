import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  FilePairingStore,
  FileWorkspaceAccessStore,
  consumePairingCodeInState,
  createEmptyPairingState,
  createEmptyWorkspaceAccessState,
  normalizePairingState,
  normalizeWorkspaceAccessState,
  type ConsumePairingCodeInput,
  type ConsumePairingCodeResult,
  type PairingState,
  type WorkspaceAccessState,
} from '@opentag/config';
import {
  FileDeliveryStore,
  createEmptyDeliveryState,
  normalizeDeliveryState,
  upsertThreadBindingInState,
  type FileDeliveryState,
  type ThreadBinding,
} from '@opentag/delivery';
import {
  StateMemoryStore,
  createEmptyMemoryState,
  normalizeMemoryState,
  readLegacyMemoryState,
  type MemoryState,
} from '@opentag/memory';
import {
  FileRoutineStore,
  createEmptyRoutineState,
  normalizeRoutineState,
  trimRoutineState,
  type RoutineState,
} from '@opentag/routines';
import {
  FileWorkflowStore,
  createEmptyWorkflowState,
  normalizeWorkflowState,
  trimWorkflowState,
  type WorkflowState,
} from '@opentag/workflows';

const SCHEMA_VERSION = 2;
const DELIVERY_DOCUMENT = 'delivery';
const PAIRING_DOCUMENT = 'pairing';
const ACCESS_DOCUMENT = 'access';
const MEMORY_DOCUMENT = 'memory';
const ROUTINES_DOCUMENT = 'routines';
const WORKFLOWS_DOCUMENT = 'workflows';
const DELIVERY_META_ID = 1;

const DELIVERY_COLLECTIONS = [
  'outbox',
  'turnDeliveries',
  'threadBindings',
  'inboundEvents',
  'agentRuns',
  'agentRunEvents',
  'agentRunSteering',
  'agentThreadSessions',
  'sourceThreadMessages',
  'threadContextSummaries',
  'threadContextSyncs',
  'usageRecords',
  'usageAlerts',
  'threadBindingAudit',
  'memoryWrapupJobs',
  'memoryWrapupCursors',
  'larkHistoryImportJobs',
  'toolApprovals',
  'dataLifecycleAudit',
] as const satisfies readonly (keyof FileDeliveryState)[];

type DeliveryCollection = (typeof DELIVERY_COLLECTIONS)[number];
type DeliveryRecord = { id: string };

interface DeliveryMetaRow {
  schema_version: number;
  next_sequence: number;
  next_steering_sequence: number;
  next_agent_run_event_sequence: number;
}

interface DeliveryRecordRow {
  collection: DeliveryCollection;
  record_key: string;
  ordinal: number;
  value_json: string;
}

interface StateDocumentRow {
  schema_version: number;
  value_json: string;
}

export interface SqliteMigrationSummary {
  deliveryImported: boolean;
  deliverySplitMigrated: boolean;
  pairingImported: boolean;
  accessImported: boolean;
  memoryImported: boolean;
  routinesImported: boolean;
  workflowsImported: boolean;
}

export interface SqliteOpenTagStoreOptions {
  databasePath: string;
  pairingTtlMs?: number;
  busyTimeoutMs?: number;
  legacyDeliveryFile?: string;
  legacyPairingFile?: string;
  legacyAccessFile?: string;
  legacyMemoryDir?: string;
  legacyRoutineFile?: string;
  legacyWorkflowFile?: string;
}

export interface AtomicPairingBindingInput extends ConsumePairingCodeInput {
  title?: string;
}

export interface AtomicPairingBindingResult {
  consumed: ConsumePairingCodeResult;
  binding?: ThreadBinding;
}

function readLegacyState<T>(
  filePath: string | undefined,
  normalize: (input: Record<string, unknown>) => T,
  fallback: () => T,
): { state: T; imported: boolean } {
  if (!filePath || !fs.existsSync(filePath)) {
    return { state: fallback(), imported: false };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
      string,
      unknown
    >;
    return { state: normalize(parsed), imported: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`sqlite_legacy_import_failed:${filePath}:${message}`);
  }
}

function isSqliteLockError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    /database (?:is )?locked/iu.test(error.message)
  );
}

const sqliteRetryWait = new Int32Array(new SharedArrayBuffer(4));

function retrySqliteLock<T>(operation: () => T, timeoutMs: number): T {
  const deadline = Date.now() + timeoutMs;
  let waitMs = 10;
  while (true) {
    try {
      return operation();
    } catch (error) {
      const remainingMs = deadline - Date.now();
      if (!isSqliteLockError(error) || remainingMs <= 0) throw error;
      Atomics.wait(
        sqliteRetryWait,
        0,
        0,
        Math.min(waitMs, remainingMs),
      );
      waitMs = Math.min(waitMs * 2, 250);
    }
  }
}

class SqliteStateBackend {
  readonly databasePath: string;
  readonly migration: SqliteMigrationSummary;
  private readonly database: Database.Database;
  private readonly readStatement: Database.Statement<[string]>;
  private readonly writeStatement: Database.Statement<[
    string,
    number,
    string,
    string,
  ]>;
  private deliveryCache?: {
    dataVersion: number;
    state: FileDeliveryState;
    snapshot: Map<
      DeliveryCollection,
      Map<string, { ordinal: number; json: string }>
    >;
  };

  constructor(options: SqliteOpenTagStoreOptions) {
    this.databasePath = path.resolve(options.databasePath);
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.database = new Database(this.databasePath);
    const busyTimeoutMs = Number.isFinite(options.busyTimeoutMs)
      ? Math.max(100, Math.floor(options.busyTimeoutMs as number))
      : 5_000;
    this.database.pragma(`busy_timeout = ${busyTimeoutMs}`);
    retrySqliteLock(
      () => this.database.pragma('journal_mode = WAL'),
      busyTimeoutMs,
    );
    this.database.pragma('synchronous = NORMAL');
    this.database.pragma('foreign_keys = ON');
    retrySqliteLock(
      () =>
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS opentag_state_documents (
            key TEXT PRIMARY KEY,
            schema_version INTEGER NOT NULL,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) WITHOUT ROWID;
        `),
      busyTimeoutMs,
    );
    this.readStatement = this.database.prepare(
      'SELECT schema_version, value_json FROM opentag_state_documents WHERE key = ?',
    );
    this.writeStatement = this.database.prepare(`
      INSERT INTO opentag_state_documents (key, schema_version, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        schema_version = excluded.schema_version,
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `);
    this.migration = retrySqliteLock(
      () => this.initialize(options),
      busyTimeoutMs,
    );
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  readDelivery(): FileDeliveryState {
    return this.loadDelivery().state;
  }

  private loadDelivery(mutable = false): {
    dataVersion: number;
    state: FileDeliveryState;
    snapshot: Map<
      DeliveryCollection,
      Map<string, { ordinal: number; json: string }>
    >;
  } {
    const dataVersion = this.deliveryDataVersion();
    if (this.deliveryCache?.dataVersion === dataVersion) {
      return {
        dataVersion,
        state: mutable
          ? this.deliveryCache.state
          : structuredClone(this.deliveryCache.state),
        snapshot: this.deliveryCache.snapshot,
      };
    }
    const meta = this.database
      .prepare(
        `SELECT schema_version, next_sequence, next_steering_sequence,
                next_agent_run_event_sequence
         FROM opentag_delivery_meta WHERE singleton = ?`,
      )
      .get(DELIVERY_META_ID) as DeliveryMetaRow | undefined;
    const snapshot = new Map<
      DeliveryCollection,
      Map<string, { ordinal: number; json: string }>
    >();
    for (const collection of DELIVERY_COLLECTIONS) {
      snapshot.set(collection, new Map());
    }
    if (!meta) {
      const state = createEmptyDeliveryState();
      this.deliveryCache = { dataVersion, state, snapshot };
      return {
        dataVersion,
        state: mutable ? state : structuredClone(state),
        snapshot,
      };
    }
    if (meta.schema_version > SCHEMA_VERSION) {
      throw new Error(
        `sqlite_delivery_state_newer_schema:${meta.schema_version}`,
      );
    }

    const state = createEmptyDeliveryState();
    state.nextSequence = meta.next_sequence;
    state.nextSteeringSequence = meta.next_steering_sequence;
    state.nextAgentRunEventSequence = meta.next_agent_run_event_sequence;
    const rows = this.database
      .prepare(
        `SELECT collection, record_key, ordinal, value_json
         FROM opentag_delivery_records
         ORDER BY collection, ordinal, record_key`,
      )
      .all() as DeliveryRecordRow[];
    const raw = state as unknown as Record<string, unknown>;
    for (const row of rows) {
      if (!DELIVERY_COLLECTIONS.includes(row.collection)) {
        throw new Error(`sqlite_delivery_collection_unknown:${row.collection}`);
      }
      try {
        (raw[row.collection] as unknown[]).push(JSON.parse(row.value_json));
        snapshot.get(row.collection)?.set(row.record_key, {
          ordinal: row.ordinal,
          json: row.value_json,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `sqlite_delivery_record_invalid:${row.collection}:${row.record_key}:${message}`,
        );
      }
    }
    const normalized = normalizeDeliveryState(state);
    this.deliveryCache = { dataVersion, state: normalized, snapshot };
    return {
      dataVersion,
      state: mutable ? normalized : structuredClone(normalized),
      snapshot,
    };
  }

  readPairing(): PairingState {
    return this.readDocument(
      PAIRING_DOCUMENT,
      normalizePairingState,
      createEmptyPairingState,
    );
  }

  readAccess(): WorkspaceAccessState {
    return this.readDocument(
      ACCESS_DOCUMENT,
      normalizeWorkspaceAccessState,
      createEmptyWorkspaceAccessState,
    );
  }

  readMemory(): MemoryState {
    return this.readDocument(
      MEMORY_DOCUMENT,
      normalizeMemoryState,
      createEmptyMemoryState,
    );
  }

  readRoutines(): RoutineState {
    return this.readDocument(
      ROUTINES_DOCUMENT,
      normalizeRoutineState,
      createEmptyRoutineState,
    );
  }

  readWorkflows(): WorkflowState {
    return this.readDocument(
      WORKFLOWS_DOCUMENT,
      normalizeWorkflowState,
      createEmptyWorkflowState,
    );
  }

  mutateDelivery<T>(operation: (state: FileDeliveryState) => T): T {
    let mutation: {
      dataVersion: number;
      result: T;
      state: FileDeliveryState;
      snapshot: Map<
        DeliveryCollection,
        Map<string, { ordinal: number; json: string }>
      >;
    };
    try {
      mutation = this.immediateTransaction(() => {
        const { dataVersion, state, snapshot: before } = this.loadDelivery(true);
        const result = operation(state);
        const snapshot = this.writeDeliveryChanges(before, state);
        return { dataVersion, result, state, snapshot };
      });
    } catch (error) {
      this.deliveryCache = undefined;
      throw error;
    }
    this.deliveryCache = {
      dataVersion: mutation.dataVersion,
      state: mutation.state,
      snapshot: mutation.snapshot,
    };
    return structuredClone(mutation.result);
  }

  mutatePairing<T>(operation: (state: PairingState) => T): T {
    return this.immediateTransaction(() => {
      const state = this.readPairing();
      const result = operation(state);
      this.trimPairing(state);
      this.writeDocument(PAIRING_DOCUMENT, state);
      return result;
    });
  }

  mutateAccess<T>(operation: (state: WorkspaceAccessState) => T): T {
    return this.immediateTransaction(() => {
      const state = this.readAccess();
      const result = operation(state);
      this.writeDocument(ACCESS_DOCUMENT, state);
      return result;
    });
  }

  mutateMemory<T>(operation: (state: MemoryState) => T): T {
    return this.immediateTransaction(() => {
      const state = this.readMemory();
      const result = operation(state);
      this.writeDocument(MEMORY_DOCUMENT, state);
      return result;
    });
  }

  mutateRoutines<T>(operation: (state: RoutineState) => T): T {
    return this.immediateTransaction(() => {
      const state = this.readRoutines();
      const result = operation(state);
      trimRoutineState(state);
      this.writeDocument(ROUTINES_DOCUMENT, state);
      return result;
    });
  }

  mutateWorkflows<T>(operation: (state: WorkflowState) => T): T {
    return this.immediateTransaction(() => {
      const state = this.readWorkflows();
      const result = operation(state);
      trimWorkflowState(state);
      this.writeDocument(WORKFLOWS_DOCUMENT, state);
      return result;
    });
  }

  mutatePairingAndDelivery<T>(
    operation: (pairing: PairingState, delivery: FileDeliveryState) => T,
  ): T {
    let mutation: {
      dataVersion: number;
      result: T;
      state: FileDeliveryState;
      snapshot: Map<
        DeliveryCollection,
        Map<string, { ordinal: number; json: string }>
      >;
    };
    try {
      mutation = this.immediateTransaction(() => {
        const pairing = this.readPairing();
        const {
          dataVersion,
          state: delivery,
          snapshot: beforeDelivery,
        } = this.loadDelivery(true);
        const result = operation(pairing, delivery);
        this.trimPairing(pairing);
        this.writeDocument(PAIRING_DOCUMENT, pairing);
        const snapshot = this.writeDeliveryChanges(beforeDelivery, delivery);
        return { dataVersion, result, state: delivery, snapshot };
      });
    } catch (error) {
      this.deliveryCache = undefined;
      throw error;
    }
    this.deliveryCache = {
      dataVersion: mutation.dataVersion,
      state: mutation.state,
      snapshot: mutation.snapshot,
    };
    return structuredClone(mutation.result);
  }

  private initialize(
    options: SqliteOpenTagStoreOptions,
  ): SqliteMigrationSummary {
    return this.immediateTransaction(() => {
      let deliveryImported = false;
      let deliverySplitMigrated = false;
      let pairingImported = false;
      let accessImported = false;
      let memoryImported = false;
      let routinesImported = false;
      let workflowsImported = false;
      this.createDeliveryTables();
      if (!this.hasDeliveryState()) {
        const hadDeliveryDocument = this.hasDocument(DELIVERY_DOCUMENT);
        const legacy = hadDeliveryDocument
          ? {
              state: this.readDocument(
                DELIVERY_DOCUMENT,
                normalizeDeliveryState,
                createEmptyDeliveryState,
              ),
              imported: false,
            }
          : readLegacyState(
              options.legacyDeliveryFile,
              (input) => normalizeDeliveryState(input),
              createEmptyDeliveryState,
            );
        deliveryImported = legacy.imported;
        deliverySplitMigrated = hadDeliveryDocument;
        this.writeFullDelivery(legacy.state);
        // Keep the v1 JSON as rollback evidence, but fence old binaries from
        // silently reading and overwriting a stale copy after the split.
        if (hadDeliveryDocument) {
          this.database
            .prepare(
              `UPDATE opentag_state_documents
               SET schema_version = ?, updated_at = ?
               WHERE key = ?`,
            )
            .run(SCHEMA_VERSION, new Date().toISOString(), DELIVERY_DOCUMENT);
        } else {
          this.writeStatement.run(
            DELIVERY_DOCUMENT,
            SCHEMA_VERSION,
            JSON.stringify(legacy.state),
            new Date().toISOString(),
          );
        }
      }
      if (!this.hasDocument(PAIRING_DOCUMENT)) {
        const legacy = readLegacyState(
          options.legacyPairingFile,
          (input) => normalizePairingState(input),
          createEmptyPairingState,
        );
        pairingImported = legacy.imported;
        this.writeDocument(PAIRING_DOCUMENT, legacy.state);
      }
      if (!this.hasDocument(ACCESS_DOCUMENT)) {
        const legacy = readLegacyState(
          options.legacyAccessFile,
          (input) => normalizeWorkspaceAccessState(input),
          createEmptyWorkspaceAccessState,
        );
        accessImported = legacy.imported;
        this.writeDocument(ACCESS_DOCUMENT, legacy.state);
      }
      if (!this.hasDocument(MEMORY_DOCUMENT)) {
        const legacy = options.legacyMemoryDir
          ? readLegacyMemoryState(options.legacyMemoryDir)
          : { state: createEmptyMemoryState(), imported: false };
        memoryImported = legacy.imported;
        this.writeDocument(MEMORY_DOCUMENT, legacy.state);
      }
      if (!this.hasDocument(ROUTINES_DOCUMENT)) {
        const legacy = readLegacyState(
          options.legacyRoutineFile,
          (input) => normalizeRoutineState(input),
          createEmptyRoutineState,
        );
        routinesImported = legacy.imported;
        this.writeDocument(ROUTINES_DOCUMENT, legacy.state);
      }
      if (!this.hasDocument(WORKFLOWS_DOCUMENT)) {
        const legacy = readLegacyState(
          options.legacyWorkflowFile,
          (input) => normalizeWorkflowState(input),
          createEmptyWorkflowState,
        );
        workflowsImported = legacy.imported;
        this.writeDocument(WORKFLOWS_DOCUMENT, legacy.state);
      }
      this.database.pragma(`user_version = ${SCHEMA_VERSION}`);
      return {
        deliveryImported,
        deliverySplitMigrated,
        pairingImported,
        accessImported,
        memoryImported,
        routinesImported,
        workflowsImported,
      };
    });
  }

  private hasDocument(key: string): boolean {
    return Boolean(this.readStatement.get(key));
  }

  private createDeliveryTables(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS opentag_delivery_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        next_sequence INTEGER NOT NULL,
        next_steering_sequence INTEGER NOT NULL,
        next_agent_run_event_sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS opentag_delivery_records (
        collection TEXT NOT NULL,
        record_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, record_key)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS opentag_delivery_records_order
        ON opentag_delivery_records (collection, ordinal);
    `);
  }

  private hasDeliveryState(): boolean {
    return Boolean(
      this.database
        .prepare('SELECT 1 FROM opentag_delivery_meta WHERE singleton = ?')
        .get(DELIVERY_META_ID),
    );
  }

  private deliveryDataVersion(): number {
    return this.database.pragma('data_version', { simple: true }) as number;
  }

  private writeFullDelivery(state: FileDeliveryState): void {
    this.database.prepare('DELETE FROM opentag_delivery_records').run();
    this.writeDeliveryChanges(new Map(), state);
  }

  private writeDeliveryChanges(
    before: Map<
      DeliveryCollection,
      Map<string, { ordinal: number; json: string }>
    >,
    state: FileDeliveryState,
  ): Map<
    DeliveryCollection,
    Map<string, { ordinal: number; json: string }>
  > {
    const timestamp = new Date().toISOString();
    const nextSnapshot = new Map<
      DeliveryCollection,
      Map<string, { ordinal: number; json: string }>
    >();
    const upsert = this.database.prepare(`
      INSERT INTO opentag_delivery_records
        (collection, record_key, ordinal, value_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(collection, record_key) DO UPDATE SET
        ordinal = excluded.ordinal,
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `);
    const remove = this.database.prepare(`
      DELETE FROM opentag_delivery_records
      WHERE collection = ? AND record_key = ?
    `);

    for (const collection of DELIVERY_COLLECTIONS) {
      const previous = before.get(collection) ?? new Map();
      const seen = new Set<string>();
      const nextCollection = new Map<
        string,
        { ordinal: number; json: string }
      >();
      nextSnapshot.set(collection, nextCollection);
      const records = state[collection] as unknown as DeliveryRecord[];
      const existingOrdinals = records.flatMap((record) => {
        const old = previous.get(record.id);
        return old ? [old.ordinal] : [];
      });
      const existingOrderPreserved = existingOrdinals.every(
        (ordinal, index) => index === 0 || ordinal > existingOrdinals[index - 1],
      );
      const lastExistingIndex = records.reduce(
        (last, record, index) => previous.has(record.id) ? index : last,
        -1,
      );
      const newRecordsOnlyAtTail = records.every(
        (record, index) => previous.has(record.id) || index > lastExistingIndex,
      );
      const preserveOrdinals = existingOrderPreserved && newRecordsOnlyAtTail;
      let nextOrdinal = Math.max(
        -1,
        ...[...previous.values()].map((item) => item.ordinal),
      ) + 1;
      records.forEach((record, index) => {
        if (!record?.id) {
          throw new Error(`sqlite_delivery_record_missing_id:${collection}`);
        }
        if (seen.has(record.id)) {
          throw new Error(
            `sqlite_delivery_record_duplicate_id:${collection}:${record.id}`,
          );
        }
        seen.add(record.id);
        const json = JSON.stringify(record);
        const old = previous.get(record.id);
        const ordinal = preserveOrdinals && old ? old.ordinal : preserveOrdinals
          ? nextOrdinal++
          : index;
        nextCollection.set(record.id, { ordinal, json });
        if (!old || old.ordinal !== ordinal || old.json !== json) {
          upsert.run(collection, record.id, ordinal, json, timestamp);
        }
      });
      for (const recordKey of previous.keys()) {
        if (!seen.has(recordKey)) remove.run(collection, recordKey);
      }
    }

    this.database
      .prepare(`
        INSERT INTO opentag_delivery_meta
          (singleton, schema_version, next_sequence, next_steering_sequence,
           next_agent_run_event_sequence, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          schema_version = excluded.schema_version,
          next_sequence = excluded.next_sequence,
          next_steering_sequence = excluded.next_steering_sequence,
          next_agent_run_event_sequence = excluded.next_agent_run_event_sequence,
          updated_at = excluded.updated_at
      `)
      .run(
        DELIVERY_META_ID,
        SCHEMA_VERSION,
        state.nextSequence,
        state.nextSteeringSequence,
        state.nextAgentRunEventSequence,
        timestamp,
      );
    return nextSnapshot;
  }

  private readDocument<T>(
    key: string,
    normalize: (input: Record<string, unknown>) => T,
    fallback: () => T,
  ): T {
    const row = this.readStatement.get(key) as StateDocumentRow | undefined;
    if (!row) return fallback();
    if (row.schema_version > SCHEMA_VERSION) {
      throw new Error(
        `sqlite_state_document_newer_schema:${key}:${row.schema_version}`,
      );
    }
    try {
      const parsed = JSON.parse(row.value_json) as Record<string, unknown>;
      return normalize(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`sqlite_state_document_invalid:${key}:${message}`);
    }
  }

  private writeDocument(key: string, value: unknown): void {
    this.writeStatement.run(
      key,
      SCHEMA_VERSION,
      JSON.stringify(value),
      new Date().toISOString(),
    );
  }

  private immediateTransaction<T>(operation: () => T): T {
    return this.database.transaction(operation).immediate();
  }

  private trimPairing(state: PairingState): void {
    if (state.invitations.length > 500) {
      state.invitations.splice(0, state.invitations.length - 500);
    }
  }
}

class SqliteDeliveryStore extends FileDeliveryStore {
  constructor(private readonly backend: SqliteStateBackend) {
    super(path.dirname(backend.databasePath));
  }

  protected override async readState(): Promise<FileDeliveryState> {
    return this.backend.readDelivery();
  }

  protected override async mutate<T>(
    operation: (state: FileDeliveryState) => T,
  ): Promise<T> {
    return this.backend.mutateDelivery(operation);
  }
}

class SqlitePairingStore extends FilePairingStore {
  constructor(
    private readonly backend: SqliteStateBackend,
    pairingTtlMs?: number,
  ) {
    super(path.dirname(backend.databasePath), { ttlMs: pairingTtlMs });
  }

  protected override async readState(): Promise<PairingState> {
    return this.backend.readPairing();
  }

  protected override async mutate<T>(
    operation: (state: PairingState) => T,
  ): Promise<T> {
    return this.backend.mutatePairing(operation);
  }
}

class SqliteWorkspaceAccessStore extends FileWorkspaceAccessStore {
  constructor(private readonly backend: SqliteStateBackend) {
    super(path.dirname(backend.databasePath));
  }

  protected override async readState(): Promise<WorkspaceAccessState> {
    return this.backend.readAccess();
  }

  protected override async mutate<T>(
    operation: (state: WorkspaceAccessState) => T,
  ): Promise<T> {
    return this.backend.mutateAccess(operation);
  }
}

class SqliteMemoryStore extends StateMemoryStore {
  constructor(private readonly backend: SqliteStateBackend) {
    super();
  }

  protected override async readState(): Promise<MemoryState> {
    return this.backend.readMemory();
  }

  protected override async mutate<T>(
    operation: (state: MemoryState) => T,
  ): Promise<T> {
    return this.backend.mutateMemory(operation);
  }
}

class SqliteRoutineStore extends FileRoutineStore {
  constructor(private readonly backend: SqliteStateBackend) {
    super(path.dirname(backend.databasePath));
  }

  protected override async readState(): Promise<RoutineState> {
    return this.backend.readRoutines();
  }

  protected override async mutate<T>(
    operation: (state: RoutineState) => T,
  ): Promise<T> {
    return this.backend.mutateRoutines(operation);
  }
}

class SqliteWorkflowStore extends FileWorkflowStore {
  constructor(private readonly backend: SqliteStateBackend) {
    super(path.dirname(backend.databasePath));
  }

  protected override async readState(): Promise<WorkflowState> {
    return this.backend.readWorkflows();
  }

  protected override async mutate<T>(
    operation: (state: WorkflowState) => T,
  ): Promise<T> {
    return this.backend.mutateWorkflows(operation);
  }
}

export class SqliteOpenTagStore {
  readonly deliveryStore: SqliteDeliveryStore;
  readonly pairingStore: SqlitePairingStore;
  readonly accessStore: SqliteWorkspaceAccessStore;
  readonly memoryStore: SqliteMemoryStore;
  readonly routineStore: SqliteRoutineStore;
  readonly workflowStore: SqliteWorkflowStore;
  readonly migration: SqliteMigrationSummary;
  readonly databasePath: string;
  private readonly backend: SqliteStateBackend;

  constructor(options: SqliteOpenTagStoreOptions) {
    this.backend = new SqliteStateBackend(options);
    this.databasePath = this.backend.databasePath;
    this.migration = this.backend.migration;
    this.deliveryStore = new SqliteDeliveryStore(this.backend);
    this.pairingStore = new SqlitePairingStore(
      this.backend,
      options.pairingTtlMs,
    );
    this.accessStore = new SqliteWorkspaceAccessStore(this.backend);
    this.memoryStore = new SqliteMemoryStore(this.backend);
    this.routineStore = new SqliteRoutineStore(this.backend);
    this.workflowStore = new SqliteWorkflowStore(this.backend);
  }

  async consumePairingAndConfigureBinding(
    input: AtomicPairingBindingInput,
    at = new Date(),
  ): Promise<AtomicPairingBindingResult> {
    const timestamp = at.toISOString();
    return this.backend.mutatePairingAndDelivery((pairing, delivery) => {
      const consumed = consumePairingCodeInState(pairing, input, timestamp);
      if (!consumed.ok) return { consumed };
      const invitation = consumed.invitation;
      const binding = upsertThreadBindingInState(
        delivery,
        {
          platform: input.platform,
          externalId: input.channelId,
          workspaceId: invitation.workspaceId,
          projectId: invitation.projectId,
          scope: 'channel',
          source: 'configured',
          channelId: input.channelId,
          title: input.title,
          activationMode: invitation.activationMode,
          requireMention: invitation.requireMention,
          actor: input.actorId ? `pairing:${input.actorId}` : 'pairing',
          reason: 'pairing_consumed',
          metadata: {
            pairedAt: invitation.consumedAt,
            pairedBy: input.actorId,
            pairingInvitationId: invitation.id,
          },
        },
        timestamp,
      );
      return { consumed, binding };
    });
  }

  close(): void {
    this.backend.close();
  }
}
