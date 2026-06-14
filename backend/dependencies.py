import backend.database as _db_mod

def get_db():
    db = _db_mod.SessionLocal()
    try:
        yield db
    finally:
        db.close()
