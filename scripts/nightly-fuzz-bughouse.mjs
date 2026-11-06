/**
 * The Bughouse section of the nightly ONLINE fuzz (nightly-fuzz-online.mjs imports `playBughouseGame` from here; BUGHOUSE_SPEC.md W2 / W7).
 *
 * One game = FOUR real socket.io-client players in one match, plus a fifth socket that only watches, against the actual server. STRICT: any deviation is an issue and fails the run.
 * The players' positions are tracked with the MOBILE APP's engine (src/logic/bughouse, not the server's generated mirror), so the clients are independent of the server's code.
 * What is checked, all through the real protocol:
 *  - after every commit all four players and the spectator hold the byte-identical snapshot with the same `seq`, `seq` grows by one per bug_state, and every snapshot reads back
 *    through the app engine and satisfies the conservation invariant (64 pieces, no negative pocket);
 *  - every move or drop the app engine lists is accepted by the server and is described by the bug_state it produced; a fraction of turns first sends something the server MUST
 *    refuse (an illegal move, the other board, the opponent's turn, a drop of a piece that is not in the pocket, a drop on an occupied square) with a reason from the closed list,
 *    and a refusal leaves the room untouched;
 *  - team chat and quick messages reach exactly the sender (chat echo) and the partner - the recorded events of ALL FIVE sockets are compared with the expected recipients;
 *  - a player that disconnects is taken over by a bot after the grace (needs FOUR_GRACE_MS on the server, as the 4-seat sections; otherwise it is brought back inside the grace) and gets its seat back with a
 *    snapshot equal to the room's at that seq;
 *  - the game ends (a mate, a flag, a resignation of a random seat) with ONE bug_game_over per connection, identical everywhere, equal to the result the app engine reads from the
 *    final snapshot; a late rejoin answers the same result.
 */
import * as appNamespace from '../../src/logic/bughouse/index.ts';

const BH = appNamespace.default ?? appNamespace;
const PARTNER = { 0: 3, 1: 2, 2: 1, 3: 0 };

/** A real player's side: a recorder of everything it is sent plus its OWN position built only from those snapshots. */
function bugClient(socket) {
  const c = {
    states: [],
    bySeq: new Map(),
    seatUpdates: [],
    gameOvers: [],
    chats: [],
    quicks: [],
    all: [],
    tracked: null,
    trackedSeq: -1,
    problems: [],
    startText: null,
    latest() {
      const last = this.states.at(-1);
      return last ? { seq: last.seq, text: last.state, payload: last } : { seq: this.trackedSeq, text: this.startText, payload: null };
    },
    read(text, seq, where) {
      const parsed = BH.deserializeMatch(text);
      if (!parsed.ok) {
        this.problems.push({ kind: 'client-cannot-read-snapshot', where, seq, error: parsed.error });
        return;
      }
      const wrong = BH.conservationProblems(parsed.match);
      if (wrong.length > 0) this.problems.push({ kind: 'snapshot-breaks-conservation', where, seq, wrong });
      if (BH.serializeMatch(parsed.match) !== text) this.problems.push({ kind: 'snapshot-is-not-canonical', where, seq });
      this.tracked = parsed.match;
      this.trackedSeq = seq;
    },
    start(match) {
      this.startText = match.state;
      this.read(match.state, 0, 'match_found');
    },
    startFromRejoin(state) {
      // a bug_state that followed the ack on the same socket may already have been handled: never go back to an older snapshot
      this.startText = state.state;
      if (this.trackedSeq >= state.seq) return;
      this.read(state.state, state.seq, 'rejoin');
    },
    drainProblems() {
      return this.problems.splice(0);
    },
  };
  socket.on('bug_state', (p) => {
    if (c.trackedSeq >= 0 && p.seq !== c.trackedSeq + 1) c.problems.push({ kind: 'seq-gap-or-duplicate', expected: c.trackedSeq + 1, got: p.seq });
    c.states.push(p);
    c.bySeq.set(p.seq, p);
    c.all.push('bug_state');
    c.read(p.state, p.seq, 'bug_state');
  });
  socket.on('bug_seat_update', (p) => (c.seatUpdates.push(p), c.all.push('bug_seat_update')));
  socket.on('bug_game_over', (p) => (c.gameOvers.push(p), c.all.push('bug_game_over')));
  socket.on('bug_chat_from', (p) => (c.chats.push(p), c.all.push('bug_chat_from')));
  socket.on('bug_quick_from', (p) => (c.quicks.push(p), c.all.push('bug_quick_from')));
  return c;
}

/**
 * @param ctx { connect(name), emitAck(socket, event, payload), waitFor(socket, event), until(test, ms), sleep(ms), randInt(n), maxPlies }
 */
export async function playBughouseGame(gameIndex, ctx) {
  const { connect, emitAck, waitFor, until, sleep, randInt, maxPlies } = ctx;
  const issues = [];
  const stats = { plies: 0, illegalProbes: 0, finished: false, naturalEnd: false, rejoins: 0, takeovers: 0, resigns: 0, chats: 0, quicks: 0, drops: 0 };
  const problem = (kind, extra = {}) => issues.push({ kind, game: gameIndex, ply: stats.plies, ...extra });
  const timeControl = { initialMs: 300000, incrementMs: 2000 };
  const names = [0, 1, 2, 3].map((i) => `U${gameIndex}x${i}`);
  const sockets = [];
  for (const name of names) sockets.push(await connect(name));
  const clients = sockets.map(bugClient);
  const found = sockets.map((s) => waitFor(s, 'bug_match_found')); // BEFORE the emits - the waitFor trap
  found.forEach((p) => p.catch(() => {}));
  for (let i = 0; i < 4; i++) {
    const ack = await emitAck(sockets[i], 'bug_join_queue', { timeControl });
    if (!ack.ok) problem('bug-join-queue-refused', { player: i, ack });
  }
  const matches = await Promise.all(found);
  const roomId = matches[0].roomId;
  const seatsOf = []; // by seat: { client, socket, token, connected, name }
  matches.forEach((match, i) => {
    clients[i].start(match);
    seatsOf[match.seat] = { client: clients[i], socket: sockets[i], token: match.playerToken, connected: true, name: names[i] };
  });
  if (new Set(matches.map((m) => m.roomId)).size !== 1 || new Set(matches.map((m) => m.seat)).size !== 4) problem('match-found-inconsistent', { seats: matches.map((m) => m.seat), rooms: matches.map((m) => m.roomId) });
  if (new Set(matches.map((m) => JSON.stringify({ ...m, seat: 0, playerToken: 0 }))).size !== 1) problem('match-found-snapshots-differ');
  if (matches.some((m) => m.seq !== 0 || m.timeControl.initialMs !== timeControl.initialMs || m.seats.length !== 4 || m.seats.some((s) => s.kind !== 'human'))) problem('match-found-wrong-payload', { first: { ...matches[0], playerToken: 0, state: 0 } });

  // a spectator that only watches
  const spectator = await connect(`U${gameIndex}-spec`);
  const spec = bugClient(spectator);
  const watch = await emitAck(spectator, 'bug_spectate_game', { roomId });
  if (!watch.ok) problem('spectate-refused', { watch });
  else spec.startFromRejoin(watch.state);

  const live = () => seatsOf.filter((s) => s.connected);
  const lead = () => live()[0].client;
  const seatIndexOf = (entry) => seatsOf.indexOf(entry);
  const allHave = (seq, ms = 5000) => until(() => live().every((s) => s.client.bySeq.has(seq)) && (spec.bySeq.has(seq) || spec.trackedSeq >= seq), ms);
  /** THE headline check: at this seq every connected client (and the spectator) holds the byte-identical snapshot. */
  const compareAt = (seq) => {
    const copies = live().map((s) => ({ who: `seat ${seatIndexOf(s)}`, p: s.client.bySeq.get(seq) }));
    if (spec.bySeq.has(seq)) copies.push({ who: 'spectator', p: spec.bySeq.get(seq) });
    if (copies.some((c) => !c.p)) return problem('missing-bug-state', { seq, have: copies.filter((c) => c.p).map((c) => c.who) });
    const key = (p) => JSON.stringify({ roomId: p.roomId, seq: p.seq, events: p.events, state: p.state, serverNowMs: undefined });
    const first = key(copies[0].p);
    for (const c of copies) if (key(c.p) !== first) return problem('snapshot-mismatch', { seq, a: copies[0].who, b: c.who });
    const match = BH.deserializeMatch(copies[0].p.state);
    if (match.ok) {
      const ceiling = timeControl.initialMs + timeControl.incrementMs * seq + 1000;
      if (match.match.clocks.some((clock) => clock.remainingMs > ceiling)) problem('implausible-clocks', { seq });
    }
  };
  // the server allows 10 move / drop calls per second per seat and counts refused ones too: pace to 8
  const calls = [[], [], [], []];
  const paced = async (seat) => {
    for (;;) {
      const now = Date.now();
      calls[seat] = calls[seat].filter((t) => now - t < 1000);
      if (calls[seat].length < 8) break;
      await sleep(1000 - (now - calls[seat][0]) + 5);
    }
    calls[seat].push(Date.now());
  };

  const plan = {
    resignAtPly: Math.random() < 0.5 ? 8 + randInt(30) : null,
    resignSeat: randInt(4),
    dropAtPly: Math.random() < 0.4 ? 5 + randInt(20) : null,
    dropSeat: randInt(4),
    backAfterPlies: 1 + randInt(8),
    waitForTakeover: Math.random() < 0.6,
  };
  let dropped = null; // { seat, atPly, done }
  let resigned = null; // the seat that resigned
  let graceMs = null;
  const graceShort = () => graceMs !== null && graceMs <= 10_000;
  const lastChatAt = [0, 0, 0, 0];
  let lastQuickAt = [0, 0, 0, 0];

  const bringBack = async () => {
    const entry = seatsOf[dropped.seat];
    if (lead().seatUpdates.some((u) => u.seats[dropped.seat].kind === 'bot' && u.seats[dropped.seat].botReason === 'takeover')) stats.takeovers++;
    const back = await connect(`${names[dropped.seat]}-back`);
    const client = bugClient(back);
    const ack = await emitAck(back, 'bug_rejoin', { roomId, playerToken: entry.token });
    stats.rejoins++;
    if (ack.ok && ack.finished) {
      // the match ended (a planned resignation) while this seat was away: the rejoin answers the RESULT, which must be the one everybody else got
      dropped.done = true;
      sockets.push(back);
      const others = live()[0]?.client.gameOvers[0];
      if (!others) await until(() => (live()[0]?.client.gameOvers.length ?? 0) >= 1, 5000).catch(() => {});
      const reference = live()[0]?.client.gameOvers[0];
      if (!reference || JSON.stringify(reference) !== JSON.stringify(ack.gameOver)) problem('rejoin-of-a-finished-match-differs-from-the-game-over', { ack: ack.gameOver, reference });
      return;
    }
    if (!ack.ok) return problem('rejoin-refused', { seat: dropped.seat, ack });
    await until(() => lead().latest().seq >= ack.state.seq, 5000).catch(() => {});
    const leadText = lead().bySeq.get(ack.state.seq)?.state ?? (ack.state.seq === 0 ? lead().startText : undefined);
    if (leadText !== ack.state.state) problem('rejoin-state-mismatch', { seat: dropped.seat, rejoinSeq: ack.state.seq, leadSeq: lead().latest().seq });
    if (ack.state.seat !== dropped.seat || ack.state.seats[dropped.seat].kind !== 'human' || ack.state.roomId !== roomId) problem('rejoin-did-not-restore-the-seat', { seat: dropped.seat, seats: ack.state.seats });
    if (!Number.isFinite(ack.state.serverNowMs) || !Array.isArray(ack.state.log)) problem('rejoin-answer-incomplete', { keys: Object.keys(ack.state) });
    client.startFromRejoin(ack.state);
    seatsOf[dropped.seat] = { client, socket: back, token: entry.token, connected: true, name: entry.name };
    dropped.done = true;
    sockets.push(back);
  };

  const resignSeat = async (seat) => {
    const entry = seatsOf[seat];
    if (!entry.connected || lead().tracked.result) return false;
    const seqBefore = lead().latest().seq;
    const ack = await emitAck(entry.socket, 'bug_resign', { roomId });
    if (!ack.ok) {
      problem('server-refused-resign', { seat, ack });
      return false;
    }
    stats.resigns++;
    resigned = seat;
    await until(() => lead().latest().seq > seqBefore, 5000).catch(() => problem('resignation-state-did-not-reach-everyone', { seat, seqBefore }));
    return true;
  };

  /** One chat line and one quick message from random seats (only while all four humans are connected); the recipients are checked on ALL FIVE sockets. */
  const talk = async () => {
    if (live().length !== 4 || dropped) return;
    const everyone = [...seatsOf.map((s) => s.client), spec];
    const seat = randInt(4);
    const partner = PARTNER[seat];
    const now = Date.now();
    if (now - lastChatAt[seat] > 1100 && Math.random() < 0.5) {
      lastChatAt[seat] = now;
      const text = `g${gameIndex}-${stats.plies}-${seat}`;
      const before = everyone.map((c) => c.chats.length);
      const ack = await emitAck(seatsOf[seat].socket, 'bug_chat', { roomId, text, recipients: [0, 1, 2, 3], to: 'all' });
      stats.chats++;
      if (!ack.ok || ack.delivered !== true) return problem('team-chat-refused', { seat, ack });
      await until(() => everyone.map((c) => c.chats.length).reduce((a, b) => a + b, 0) >= before.reduce((a, b) => a + b, 0) + 2, 3000).catch(() => {});
      await sleep(40);
      const got = everyone.map((c, i) => c.chats.length - before[i]);
      // index i of `everyone` is the SEAT i's client for i < 4 (seatsOf is by seat), the spectator is index 4
      const expectedBySeat = [0, 1, 2, 3].map((s) => (s === seat || s === partner ? 1 : 0)).concat([0]);
      if (JSON.stringify(got) !== JSON.stringify(expectedBySeat)) problem('team-chat-reached-the-wrong-sockets', { seat, got, expected: expectedBySeat });
      else if (seatsOf[partner].client.chats.at(-1)?.text !== text || seatsOf[partner].client.chats.at(-1)?.seat !== seat) problem('team-chat-line-is-not-the-sent-one', { seat });
    }
    if (now - lastQuickAt[seat] > 1700 && Math.random() < 0.5) {
      lastQuickAt[seat] = now;
      const code = randInt(10);
      const before = everyone.map((c) => c.quicks.length);
      const ack = await emitAck(seatsOf[seat].socket, 'bug_quick', { roomId, code, text: 'x', recipients: [0, 1, 2, 3] });
      stats.quicks++;
      if (!ack.ok || ack.delivered !== true) return problem('quick-message-refused', { seat, ack });
      await until(() => everyone.map((c) => c.quicks.length).reduce((a, b) => a + b, 0) >= before.reduce((a, b) => a + b, 0) + 1, 3000).catch(() => {});
      await sleep(40);
      const got = everyone.map((c, i) => c.quicks.length - before[i]);
      const expectedBySeat = [0, 1, 2, 3].map((s) => (s === partner ? 1 : 0)).concat([0]);
      if (JSON.stringify(got) !== JSON.stringify(expectedBySeat)) problem('quick-message-reached-the-wrong-sockets', { seat, got, expected: expectedBySeat });
      else if (seatsOf[partner].client.quicks.at(-1)?.code !== code) problem('quick-message-code-changed', { seat });
    }
  };

  for (; stats.plies < maxPlies; stats.plies++) {
    const leader = lead();
    if (leader.tracked.result) break;

    if (plan.resignAtPly === stats.plies && resigned === null) {
      await resignSeat(plan.resignSeat);
      if (lead().tracked.result) break;
    }
    if (plan.dropAtPly === stats.plies && !dropped && live().length === 4) {
      const seat = plan.dropSeat;
      const others = live().filter((s) => seatIndexOf(s) !== seat);
      const before = others.map((s) => s.client.seatUpdates.length);
      seatsOf[seat].socket.disconnect();
      seatsOf[seat].connected = false;
      dropped = { seat, atPly: stats.plies, done: false };
      await until(() => others.every((s, i) => s.client.seatUpdates.length > before[i]), 5000).catch(() => problem('no-seat-update-after-disconnect', { seat }));
      const away = others[0].client.seatUpdates.at(-1)?.seats?.[seat];
      if (!away || away.connected !== false || away.kind !== 'human' || !(away.graceMsLeft > 0)) problem('bad-away-announcement', { seat, away });
      else graceMs = away.graceMsLeft;
      // with the full 45 s grace nothing would happen for 45 s if this seat's turn came: bring the player straight back, inside the grace
      if (!graceShort()) await bringBack();
    }
    if (dropped && !dropped.done && graceShort() && stats.plies >= dropped.atPly + plan.backAfterPlies) {
      // most of the time the player stays away until a bot has taken the seat (pacing only: the bound just turns a hang into an issue)
      if (plan.waitForTakeover) {
        await until(() => lead().seatUpdates.some((u) => u.seats[dropped.seat].kind === 'bot' && u.seats[dropped.seat].botReason === 'takeover'), graceMs + 6000).catch(() => problem('no-takeover-after-the-grace', { seat: dropped.seat, graceMs }));
      }
      await bringBack();
    }

    if (stats.plies % 7 === 3) await talk();

    // the connected seats on move
    const m = leader.tracked;
    const onMove = [0, 1, 2, 3].filter((s) => seatsOf[s].connected && m.verdicts[BH.seatPlace(s).board].turn === BH.seatPlace(s).color);
    const actable = onMove.map((s) => ({ seat: s, legal: BH.legalActions(m, s) })).filter((c) => c.legal.moves.length + c.legal.drops.length > 0);
    if (actable.length === 0) {
      // nobody can act: a taken-over seat's bot has the move, or the seats on move are away - wait for the room to change
      const seqBefore = leader.latest().seq;
      const ok = await until(() => lead().latest().seq > seqBefore, (graceMs ?? 1500) + 10_000).then(() => true, () => false);
      if (!ok) {
        problem('stalled-waiting-for-the-room', { seqBefore, graceMs, verdicts: m.verdicts });
        break;
      }
      const after = lead().latest().payload;
      await allHave(after.seq).catch(() => {});
      compareAt(after.seq);
      continue;
    }
    const chosen = actable[randInt(actable.length)];
    const seat = chosen.seat;
    const board = BH.seatPlace(seat).board;
    const mover = seatsOf[seat];
    const { moves, drops } = chosen.legal;

    // Probes: something the server MUST refuse, and which must leave the room untouched.
    const probes = [];
    if (moves.length > 0 && Math.random() < 0.3) {
      const pick = moves[randInt(moves.length)];
      const tos = new Set(moves.filter((x) => x.from === pick.from).map((x) => x.to));
      const files = 'abcdefgh';
      let to = null;
      for (let tries = 0; tries < 20 && to === null; tries++) {
        const sq = `${files[randInt(8)]}${1 + randInt(8)}`;
        if (sq !== pick.from && !tos.has(sq)) to = sq;
      }
      if (to) probes.push({ socket: mover.socket, event: 'bug_move', payload: { roomId, board, from: pick.from, to }, kind: 'server-ACCEPTED-illegal-bughouse-move', seat });
    }
    if (Math.random() < 0.15) {
      const other = board === 'A' ? 'B' : 'A';
      const pick = moves.length > 0 ? moves[0] : { from: 'e2', to: 'e4' };
      probes.push({ socket: mover.socket, event: 'bug_move', payload: { roomId, board: other, from: pick.from, to: pick.to }, kind: 'server-ACCEPTED-a-move-on-the-other-board', seat });
    }
    if (Math.random() < 0.15) {
      const opponent = BH.opponentOnBoard(seat);
      if (seatsOf[opponent].connected) probes.push({ socket: seatsOf[opponent].socket, event: 'bug_move', payload: { roomId, board, from: 'a2', to: 'a3' }, kind: 'server-ACCEPTED-an-out-of-turn-move', seat: opponent });
    }
    if (Math.random() < 0.2) {
      const empty = ['q', 'r', 'b', 'n', 'p'].find((piece) => m.pockets[seat][piece] === 0);
      if (empty) probes.push({ socket: mover.socket, event: 'bug_drop', payload: { roomId, board, piece: empty, square: 'e4' }, kind: 'server-ACCEPTED-a-drop-from-an-empty-pocket', seat });
    }
    if (drops.length > 0 && Math.random() < 0.3) {
      const piece = drops[0].piece;
      const free = new Set(drops.filter((d) => d.piece === piece).map((d) => d.square));
      const occupied = ['e1', 'e8', 'd1', 'd8', 'a1', 'h8'].find((sq) => !free.has(sq));
      if (occupied) probes.push({ socket: mover.socket, event: 'bug_drop', payload: { roomId, board, piece, square: occupied }, kind: 'server-ACCEPTED-a-drop-on-an-illegal-square', seat });
    }
    const seqBefore = leader.latest().seq;
    for (const probe of probes) {
      stats.illegalProbes++;
      await paced(probe.seat);
      const ack = await emitAck(probe.socket, probe.event, probe.payload);
      if (ack.ok) problem(probe.kind, { payload: probe.payload, ack });
      else if (!BH.BUG_REJECT_REASONS.includes(ack.reason)) problem('refusal-without-a-reason-from-the-closed-list', { ack, kind: probe.kind });
    }
    if (probes.length > 0) {
      await sleep(15);
      if (live().some((s) => s.client.latest().seq !== seqBefore)) {
        // a taken-over bot may legitimately have moved meanwhile: only a change in the probing client's own view that the app engine cannot explain counts
        const seqs = live().map((s) => s.client.latest().seq);
        if (!dropped) problem('refused-request-changed-the-room', { seqBefore, seqNow: seqs });
      }
    }

    // the real action: from the app engine's own list
    const useDrop = drops.length > 0 && (moves.length === 0 || Math.random() < 0.5);
    let payload;
    let event;
    if (useDrop) {
      const drop = drops[randInt(drops.length)];
      event = 'bug_drop';
      payload = { roomId, board, piece: drop.piece, square: drop.square };
      stats.drops++;
    } else {
      const preferred = moves.filter((x) => !x.promotion || x.promotion === 'q');
      const pick = (preferred.length > 0 ? preferred : moves)[randInt(preferred.length > 0 ? preferred.length : moves.length)];
      event = 'bug_move';
      payload = { roomId, board, from: pick.from, to: pick.to, ...(pick.promotion ? { promotion: pick.promotion } : {}) };
    }
    await paced(seat);
    const ack = await emitAck(mover.socket, event, payload);
    if (!ack.ok) {
      // the match may have been ended by a flag or a takeover bot's mate between our read and our send: then the answer is flagDue / over / noGame
      if (['flagDue', 'over', 'noGame'].includes(ack.reason) && (lead().tracked.result || lead().latest().seq !== seqBefore)) {
        await sleep(30);
        continue;
      }
      problem('server-rejected-a-legal-bughouse-action', { seat, event, payload, ack, state: lead().latest().text });
      break;
    }
    await allHave(ack.seq).catch(() => {});
    compareAt(ack.seq);
    const sent = mover.client.bySeq.get(ack.seq);
    if (sent) {
      const described = sent.events.find((e) => e.kind === (event === 'bug_move' ? 'move' : 'drop'));
      const same = described && described.seat === seat && described.board === board && (event === 'bug_move' ? described.from === payload.from && described.to === payload.to : described.piece === payload.piece && described.square === payload.square);
      if (!same) problem('bug-state-does-not-describe-the-action', { sent: payload, events: sent.events });
    } else problem('no-bug-state-for-the-ack', { ackSeq: ack.seq });
  }

  // If a seat was dropped and never came back, bring it back now (its token must still work), so the end of the game is seen by all four.
  if (dropped && !dropped.done) await bringBack().catch((e) => problem('rejoin-threw', { error: String(e) }));

  // End the match: it may have ended by itself; otherwise a random seat resigns.
  stats.naturalEnd = !!lead().tracked.result;
  if (!lead().tracked.result) await resignSeat(randInt(4));
  const ended = await until(() => live().every((s) => s.client.gameOvers.length >= 1) && spec.gameOvers.length >= 1, 8000).then(() => true, () => false);
  if (!ended) problem('no-game-over-for-some-connection', { seqs: live().map((s) => s.client.latest().seq), overs: live().map((s) => s.client.gameOvers.length), spectator: spec.gameOvers.length });
  else {
    stats.finished = true;
    const over = live()[0].client.gameOvers[0];
    for (const s of live()) {
      if (s.client.gameOvers.length !== 1) problem('game-over-delivered-more-than-once', { seat: seatIndexOf(s), count: s.client.gameOvers.length });
      if (JSON.stringify(s.client.gameOvers[0]) !== JSON.stringify(over)) problem('game-over-differs-between-seats', { a: over, b: s.client.gameOvers[0] });
    }
    if (JSON.stringify(spec.gameOvers[0]) !== JSON.stringify(over)) problem('game-over-differs-for-the-spectator', { a: over, b: spec.gameOvers[0] });
    const final = BH.deserializeMatch(over.state);
    if (!final.ok) problem('client-cannot-read-the-final-snapshot', { error: final.error });
    else {
      if (JSON.stringify(final.match.result) !== JSON.stringify(over.result)) problem('game-over-result-disagrees-with-the-snapshot', { engine: final.match.result, got: over.result });
      if (final.match.result === null) problem('game-over-without-a-result-in-the-snapshot');
      else if ('winnerTeam' in final.match.result) {
        const r = final.match.result;
        if (!['checkmate', 'flag', 'resign'].includes(r.reason)) problem('bughouse-game-over-with-a-foreign-reason', { r });
        if (r.reason === 'resign' && resigned !== null && r.loserSeat !== resigned) problem('resign-result-names-the-wrong-seat', { r, resigned });
        if (r.reason === 'checkmate' && final.match.verdicts[r.board].status !== 'checkmate') problem('checkmate-result-without-a-mate', { r });
      } else problem('voided-result-in-a-game-with-humans-present', { result: final.match.result });
      const last = lead().latest();
      if (last.text !== over.state) problem('game-over-snapshot-differs-from-the-last-bug-state', { lastSeq: last.seq });
    }
    for (const s of live()) {
      const seqs = s.client.states.map((p) => p.seq);
      if (seqs.some((q, i) => i > 0 && q !== seqs[i - 1] + 1)) problem('seq-not-contiguous', { seat: seatIndexOf(s), seqs: seqs.slice(0, 60) });
    }
    // a late rejoin of the finished match answers the result
    const late = await connect(`U${gameIndex}-late`);
    const lateAck = await emitAck(late, 'bug_rejoin', { roomId, playerToken: seatsOf[randInt(4)].token });
    if (!(lateAck.ok === true && lateAck.finished === true && JSON.stringify(lateAck.gameOver) === JSON.stringify(over))) problem('rejoin-after-end-wrong', { ack: lateAck });
    late.disconnect();
  }
  // the spectator never receives chat or quick messages
  if (spec.chats.length > 0 || spec.quicks.length > 0) problem('spectator-received-a-message', { chats: spec.chats.length, quicks: spec.quicks.length });
  for (const s of seatsOf) s.socket.disconnect();
  spectator.disconnect();
  sockets.forEach((s) => s.disconnect());
  for (const c of [...clients, spec]) issues.push(...c.drainProblems().map((p) => ({ ...p, game: gameIndex })));
  return { stats, issues };
}
