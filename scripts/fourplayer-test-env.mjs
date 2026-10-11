// Imported FIRST by the 4 Player handler tests: src/lib/jwt.ts throws at import time when JWT_SECRET is unset (it is set in backend/.env for
// the real server, but the scripts that import the handlers directly run without it). A fixed test secret; nothing here touches the real one.
process.env.JWT_SECRET ??= 'test-secret-for-the-fourplayer-handler-tests';
