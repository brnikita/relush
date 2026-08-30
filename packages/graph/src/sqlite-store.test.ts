import { runGraphStoreConformance } from "./conformance.ts";
import { SqliteGraphStore } from "./sqlite-store.ts";

/**
 * SQLite is the sole `GraphStore` implementation (ADR-001), so it carries the
 * whole conformance suite. A second backend would add one line here.
 */
runGraphStoreConformance("SqliteGraphStore", () => new SqliteGraphStore({ path: ":memory:" }));
