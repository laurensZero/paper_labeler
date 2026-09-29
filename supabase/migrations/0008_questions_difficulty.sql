-- questions.difficulty：1–5 星难度，未标注为 null
alter table questions
  add column if not exists difficulty smallint
  check (difficulty is null or (difficulty between 1 and 5));
