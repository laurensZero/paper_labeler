from backend.database import engine
from sqlalchemy import inspect as sa_inspect

insp = sa_inspect(engine)
print("=== SQLite tables ===")
for t in sorted(insp.get_table_names()):
    cols = insp.get_columns(t)
    fks = insp.get_foreign_keys(t)
    print(f"\n[{t}]")
    for c in cols:
        pk = " PK" if c.get("primary_key") else ""
        nn = "" if c.get("nullable", True) else " NOT NULL"
        print(f"  {c['name']}: {c['type']}{pk}{nn}")
    for fk in fks:
        print(f"  FK {fk.get('constrained_columns')} -> {fk.get('referred_table')}.{fk.get('referred_columns')}")
