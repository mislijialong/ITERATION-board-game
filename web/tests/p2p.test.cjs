'use strict';
/* P2P protocol test: host-authoritative room over a fake synchronous transport.
 * Verifies join handshake, lobby readiness, game start, private-view snapshots,
 * and a guest command that is acknowledged and applied by the host engine. */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const root = path.join(__dirname, '..');

globalThis.GameConfig = require(path.join(root, 'game/game_config.js'));
const engine = require(path.join(root, 'game/game_engine.js'));
globalThis.HistoryGame = engine.HistoryGame;
globalThis.PATENTS = engine.PATENTS;
globalThis.Flow = require(path.join(root, 'game/game_flow.js'));
globalThis.TabletopTesting = require(path.join(root, 'src/tabletop-v4-testing.js'));
const P2P = require(path.join(root, 'src/tabletop-v4-p2p.js'));
const data = require(path.join(root, 'game/game_data.json'));

function link(host, guest) {
  host.transport = {
    name: 'test', selfId: 'HOST',
    sendTo: (peerId, msg) => guest.handleMessage(JSON.parse(JSON.stringify(msg)), 'HOST'),
    broadcast: () => {}
  };
  guest.transport = {
    name: 'test', selfId: 'GUEST',
    sendTo: (peerId, msg) => host.handleMessage(JSON.parse(JSON.stringify(msg)), 'GUEST'),
    broadcast: () => {}
  };
}

function setup() {
  const state = P2P.createRoomState('ABCDE', '测试房间', 2, 'normal', data);
  state.seats = [
    { seat: 0, name: '房主', token: 't0', online: true, ready: true, seen: Date.now() },
    { seat: 1, name: '', token: 't1', online: false, ready: false, seen: Date.now() }
  ];
  const hostSnaps = [], guestSnaps = [];
  const host = new P2P.TabletopP2PConnection(
    { room: 'ABCDE', seat: 0, token: 't0', name: '房主', isHost: true },
    { isHost: true, roomState: state, data, save() {}, onSnapshot: s => hostSnaps.push(s), onStatus() {}, onError() {} }
  );
  const guest = new P2P.TabletopP2PConnection(
    { room: 'ABCDE', seat: null, token: null, name: '客人', isHost: false },
    { isHost: false, data, save() {}, onSnapshot: s => guestSnaps.push(s), onStatus() {}, onError() {} }
  );
  link(host, guest);
  return { host, guest, hostSnaps, guestSnaps, state };
}

test('P2P handshake, ready and start with private views', async () => {
  const { host, guest, hostSnaps, guestSnaps, state } = setup();
  host.transport.sendTo('GUEST', { kind: 'whoami' });

  // Guest is assigned the free seat and token.
  assert.equal(guest.id.seat, 1);
  assert.equal(guest.id.token, 't1');
  assert.equal(guestSnaps[guestSnaps.length - 1].seats[1].online, true);
  assert.equal(guestSnaps[guestSnaps.length - 1].spectator, false);

  // Guest readies; host sees it.
  await guest.lobby('ready', { ready: true });
  assert.equal(state.seats[1].ready, true);

  // Host starts the game.
  await host.lobby('start');
  assert.ok(state.game, 'host should hold the authoritative engine');
  const lastGuest = guestSnaps[guestSnaps.length - 1];
  assert.equal(lastGuest.started, true);
  assert.equal(lastGuest.view.players.length, 2);
  assert.equal(lastGuest.view.players[1].name, '客人');
  assert.ok(Array.isArray(lastGuest.view.players[1].hand), 'guest sees own hand');
  assert.ok(!Array.isArray(lastGuest.view.players[0].hand), 'guest must not see host hand');
  const lastHost = hostSnaps[hostSnaps.length - 1];
  assert.ok(Array.isArray(lastHost.view.players[0].hand), 'host sees own hand');
});

test('P2P guest command is acknowledged and applied by host', async () => {
  const { host, guest, guestSnaps } = setup();
  host.transport.sendTo('GUEST', { kind: 'whoami' });
  await guest.lobby('ready', { ready: true });
  // Deterministic seed: starter = 0, so the compensation reward belongs to guest seat 1.
  const realNow = Date.now;
  Date.now = () => 12345;
  try { await host.lobby('start'); } finally { Date.now = realNow; }

  const game = host.roomState.game;
  const pending = game.s.pending;
  assert.ok(pending && pending.op === 'reward', 'first pending should be a reward, got ' + JSON.stringify(pending));
  assert.equal(pending.actor, 1, 'reward should belong to guest seat 1');
  const rev = guestSnaps[guestSnaps.length - 1].view.revision;
  const beforeVersion = guestSnaps[guestSnaps.length - 1].version;
  await guest.command('answer', { id: pending.id, groups: [[2], [], []] }, rev);

  assert.notEqual(game.s.pending?.id, pending.id, 'host engine should apply guest command (reward resolved)');
  assert.notEqual(game.s.pending?.op, 'reward', 'reward should be resolved, game may proceed to next pending');
  const after = guestSnaps[guestSnaps.length - 1];
  assert.ok(after.version > beforeVersion, 'guest should receive a newer snapshot');
  assert.ok(after.view.revision > rev, 'guest revision should advance');
  assert.equal(guest.pending, null, 'guest pending command should be cleared');
});