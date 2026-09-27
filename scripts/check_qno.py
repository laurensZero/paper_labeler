import sqlite3

con = sqlite3.connect("data/app.db")
print("sample qno:")
for r in con.execute("select id, paper_id, question_no from questions limit 25").fetchall():
    print(" ", r)

print("dup qno:")
for r in con.execute(
    "select question_no, count(*) c from questions "
    "where question_no is not null and question_no != '' "
    "group by question_no having c > 1 limit 10"
).fetchall():
    print(" ", r)

print("papers filenames:")
for r in con.execute("select id, filename, exam_code from papers limit 25").fetchall():
    print(" ", r)

print("filename unique index?", con.execute(
    "select name from sqlite_master where type='index' and tbl_name='papers' and sql like '%unique%'"
).fetchall())
