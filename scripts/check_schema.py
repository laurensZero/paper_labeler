import sqlite3

con = sqlite3.connect("data/app.db")

print("=== sqlite_master indexes/tables ===")
for name, typ, sql in con.execute(
    "select name, type, sql from sqlite_master where type in ('table','index') order by type, name"
).fetchall():
    if sql:
        print(f"{typ} {name}: {sql}")

print("\n=== answers.question_id uniqueness ===")
print(con.execute("select sql from sqlite_master where name='sqlite_autoindex_answers_1'").fetchall())

print("\n=== papers.filename uniqueness ===")
print(
    con.execute(
        "select sql from sqlite_master where name='papers'"
    ).fetchone()[0]
)

print("\n=== updated_at nulls ===")
for t in ("papers", "questions", "answers", "section_defs", "section_groups", "compositions"):
    try:
        n = con.execute(f"select count(*) from {t} where updated_at is null").fetchone()[0]
        print(t, n)
    except Exception as e:
        print(t, "ERR", e)

print("\n=== composition_items unique ===")
for r in con.execute(
    "select name, sql from sqlite_master where type='index' and tbl_name='composition_items'"
).fetchall():
    print(r)

print("\n=== question_sections unique ===")
for r in con.execute(
    "select name, sql from sqlite_master where type='index' and tbl_name='question_sections'"
).fetchall():
    print(r)

print("\n=== section_group_members unique? ===")
for r in con.execute(
    "select name, sql from sqlite_master where type='index' and tbl_name='section_group_members'"
).fetchall():
    print(r)
print("dup section_name in members?")
print(
    con.execute(
        "select section_name, count(*) c from section_group_members group by section_name having c>1"
    ).fetchall()
)
print("same section in two groups?")
print(
    con.execute(
        "select section_name, count(distinct group_id) g from section_group_members group by section_name having g>1"
    ).fetchall()
)
