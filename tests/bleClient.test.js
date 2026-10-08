const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const protocol = require("../src/utils/protocol");
const eventParser = require("../src/utils/nativeBleEvent");
const identity = require("../src/utils/deviceIdentity");

const MAC = "DE04C44C-7971-7E3A-74D1-EB1BFFB58EB7";
const INFO =
  "ACCA01340077F7E00077D5E00052000100060001010000000000000000000000000000000000000000020500000300000000000000000000";
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
class Clock {
  now = 1000;
  next = 0;
  timers = new Map();
  setTimeout = (fn, ms) => {
    const id = ++this.next;
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async advance(ms) {
    const end = this.now + ms;
    await flush();
    for (let i = 0; i < 10000; i++) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
  async settle(promise, maxMs = 60000) {
    let state = "pending",
      value;
    promise.then(
      (v) => {
        state = "resolved";
        value = v;
      },
      (e) => {
        state = "rejected";
        value = e;
      }
    );
    for (
      let elapsed = 0;
      state === "pending" && elapsed <= maxMs;
      elapsed += 50
    )
      await this.advance(50);
    assert.notEqual(state, "pending", "operation should settle");
    if (state === "rejected") throw value;
    return value;
  }
}
function fixture(options = {}) {
  const clock = new Clock(),
    listeners = new Map(),
    calls = [],
    writes = [];
  let connected = options.connected ?? true,
    physicalState = connected ? 2 : 0;
  let requested = new Set(),
    notifications = new Set(),
    polls = new Map(),
    connectionCount = 0,
    servicesReadyAt = 0;
  const emit = (type, data) => listeners.get("callJsRnBle")?.({ type, data });
  const reply = (type, data) => queueMicrotask(() => emit(type, data));
  const response = (pkg, uuid = protocol.UUIDS.control) =>
    reply(2200, {
      mac: MAC,
      serviceUuid: protocol.UUIDS.service,
      chacUuid: uuid,
      pkg,
    });
  class Emitter {
    addListener(name, handler) {
      listeners.set(name, handler);
      return { remove: () => listeners.delete(name) };
    }
  }
  const bridge = (raw) => {
    const { type, data } = JSON.parse(raw);
    calls.push({ type, data, time: clock.now });
    if (options.rejectType === type)
      return Promise.reject(new Error("bridge rejected"));
    if (options.holdType === type) return Promise.resolve({ ret: "1" });
    if (type === 1007)
      reply(2010, {
        macAddress: MAC,
        connectStatus: connected ? 1 : physicalState === 1 ? 3 : 2,
        ...(options.legacyInfo
          ? {}
          : {
              requestId: data.requestId,
              peripheralState: physicalState,
            }),
      });
    if (type === 1009) {
      connectionCount++;
      if (options.connectFail) reply(2012, { mac: MAC, errorCode: 1 });
      else {
        if (options.connectingFirst)
          reply(2007, { mac: MAC, connectStatus: 3 });
        connected = true;
        physicalState = 2;
        servicesReadyAt = clock.now + (options.servicesReadyDelay || 0);
        reply(2007, { mac: MAC, connectStatus: 1 });
      }
    }
    if (type === 1008) {
      connected = false;
      physicalState = 3;
      notifications.clear();
      requested.clear();
      polls.clear();
      reply(2007, { mac: MAC, connectStatus: 2 });
      clock.setTimeout(() => {
        physicalState = 0;
      }, 300);
    }
    if (
      type === 1006 &&
      (!options.mtuOnlyAfterReconnect || connectionCount >= 1)
    )
      reply(2205, {
        mac: MAC,
        requestId: data.requestId,
        mtu: options.mtu || 515,
      });
    if (type === 1003) {
      requested.add(data.notifyUuid);
      if (options.platform === "android")
        clock.setTimeout(() => notifications.add(data.notifyUuid), 100);
      if (data.enable === false) notifications.delete(data.notifyUuid);
    }
    if (type === 1004) {
      for (const uuid of requested) {
        polls.set(uuid, (polls.get(uuid) || 0) + 1);
        const blocked =
          options.neverNotify ||
          (options.notifyOnlyAfterReconnect && connectionCount < 2);
        if (!blocked && polls.get(uuid) >= (options.notifyPolls || 3))
          notifications.add(uuid);
      }
      const chacs = [
        {
          uuid: protocol.UUIDS.write,
          properties: options.writeProperties ?? 0x16,
        },
        { uuid: protocol.UUIDS.control, properties: 0x1a },
        { uuid: protocol.UUIDS.offline, properties: 0x1a },
      ].map((c) => ({
        ...c,
        ...(options.missingNotifyField
          ? {}
          : { isNotifying: notifications.has(c.uuid) }),
      }));
      reply(2009, {
        mac: MAC,
        requestId: data.requestId,
        services:
          clock.now >= servicesReadyAt
            ? [{ uuid: protocol.UUIDS.service, chacs }]
            : [],
      });
    }
    if (type === 1000) {
      const command = Number.parseInt(data.pkgs[0].slice(4, 6), 16);
      writes.push({
        command,
        data,
        notifying: notifications.has(protocol.UUIDS.control),
        offline: notifications.has(protocol.UUIDS.offline),
        time: clock.now,
      });
      if (!options.missingWriteCallback)
        reply(2203, {
          mac: MAC,
          sn: data.sn,
          status: options.writeFail ? 0 : 1,
        });
      if (options.noResponse || options.writeFail)
        return Promise.resolve({ ret: "1" });
      if (command === 1) {
        if (options.fragmented) {
          response(INFO.slice(0, 18), "D0D3");
          response(INFO.slice(18), "D0D3");
        } else response(INFO);
      } else if (command === 2) {
        if (options.fileListStartState) response("ACCA020100");
        if (options.missingFileListEnd)
          response("ACCA02180032303236303931353130323131350001B22D0000001B00");
        else if (options.fileListFail) response("ACCA020101");
        else response("ACCA020102");
      } else if (command === 8) {
        response(
          options.invalidDownloadStart ? "ACCA080100" : "ACCA08050000000003"
        );
        response("010203", protocol.UUIDS.offline);
        response("ACCA080102");
      } else response(`ACCA${command.toString(16).padStart(2, "0")}0100`);
    }
    if (options.pendingNotifyPromise && type === 1003)
      return new Promise(() => {});
    return Promise.resolve({ ret: "1" });
  };
  const source = fs
    .readFileSync(path.join(__dirname, "../src/services/aiM8Ble.js"), "utf8")
    .replace(/^import[\s\S]*?from\s*["'][^"']+["'];\s*/gm, "")
    .replace(
      "export { createAiM8BleClient };",
      "globalThis.createClient = createAiM8BleClient;"
    );
  const context = {
    ...protocol,
    ...eventParser,
    ...identity,
    Uint8Array,
    Map,
    Set,
    console,
    Date: class extends Date {
      constructor(...args) {
        super(...(args.length ? args : [clock.now]));
      }
      static now() {
        return clock.now;
      }
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    NativeModules: { NativeEventSendModule: { myInit() {} } },
    NativeEventEmitter: Emitter,
    DeviceEventEmitter: new Emitter(),
    Platform: { OS: options.platform || "ios" },
    NativeLocalStorage: { sendThirdBleData: bridge },
    RNFS: {
      DocumentDirectoryPath: "/documents",
      writeFile: async () => {},
      appendFile: async () => {},
      mkdir: async () => {},
      exists: async () => false,
      moveFile: async () => {},
      unlink: async () => {},
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const client = context.createClient({
    mac: MAC,
    deviceId: "",
    connected: options.launchConnected ?? false,
  });
  return {
    client,
    clock,
    calls,
    writes,
    emit,
    notifications,
    requested,
    setNoResponse: (v) => (options.noResponse = v),
  };
}

test("reused connection is prepared; first write waits for actual D0D3 notification", async () => {
  const f = fixture({ launchConnected: true });
  const a = f.client.prepare(),
    b = f.client.prepare();
  assert.equal(a, b);
  const info = await f.clock.settle(a);
  assert.equal(info.battery, 82);
  assert.equal(info.firmware, "v1.0.6");
  assert.equal(f.calls.filter((c) => c.type === 1009).length, 1);
  assert.equal(f.calls.find((c) => c.type === 1009).data.prepare, true);
  assert.ok(f.calls.filter((c) => c.type === 1004).length >= 3);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].notifying, true);
  assert.equal(f.writes[0].data.writeType, "withoutResponse");
  assert.equal(f.writes[0].data.autoNotify, false);
  assert.ok(f.calls.every((call) => call.data.bleApiVersion === undefined));
  f.client.stop();
});
test("stale launch connected flag is corrected before establishing a connection", async () => {
  const f = fixture({ launchConnected: true, connected: false });
  await f.clock.settle(f.client.prepare());
  assert.equal(f.writes.length, 1);
  f.client.stop();
});
test("async bridge rejection settles promptly and leaves no pending operation", async () => {
  const f = fixture({ rejectType: 1003 });
  const p = f.client.prepare();
  await assert.rejects(f.clock.settle(p), /bridge rejected/);
  assert.equal(f.writes.length, 0);
  f.client.stop();
});
test("notification timeout never sends a command; recovery is bounded to one reconnect", async () => {
  const f = fixture({ neverNotify: true });
  await assert.rejects(f.clock.settle(f.client.prepare()), /通知订阅超时/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.calls.filter((c) => c.type === 1008).length, 1);
  assert.equal(f.calls.filter((c) => c.type === 1009).length, 2);
  f.client.stop();
});
test("one reconnect clears a stale notification state and then preparation succeeds", async () => {
  const f = fixture({ notifyOnlyAfterReconnect: true });
  await f.clock.settle(f.client.prepare());
  const disconnect = f.calls.find((c) => c.type === 1008),
    reconnect = f.calls.filter((c) => c.type === 1009)[1];
  assert.ok(reconnect.time - disconnect.time >= 300);
  assert.equal(f.writes.length, 1);
  f.client.stop();
});
test("disconnect cancels old in-flight and queued commands across reconnection", async () => {
  const f = fixture();
  await f.clock.settle(f.client.prepare());
  f.setNoResponse(true);
  const a = f.client.queryDeviceInfo(),
    b = f.client.setTime();
  const results = Promise.allSettled([a, b]);
  await f.clock.advance(0);
  f.emit(2007, { mac: MAC, connectStatus: 2 });
  f.emit(2007, { mac: MAC, connectStatus: 1 });
  const settled = await f.clock.settle(results);
  assert.ok(
    settled.every(
      (r) => r.status === "rejected" && r.reason.code === "BLE_SESSION_CHANGED"
    )
  );
  assert.equal(f.writes.filter((w) => w.command === 3).length, 0);
  f.client.stop();
});
test("stop cancels notification polling and late responses cannot trigger writes", async () => {
  const f = fixture({ neverNotify: true });
  const p = f.client.prepare();
  p.catch(() => {});
  await f.clock.advance(300);
  f.client.stop();
  const before = f.calls.length;
  await assert.rejects(
    f.clock.settle(p),
    (e) => e.code === "BLE_SESSION_CHANGED"
  );
  await f.clock.advance(15000);
  assert.equal(f.calls.length, before);
  assert.equal(f.writes.length, 0);
});
test("connection state without version metadata does not block preparation", async () => {
  const f = fixture({ legacyInfo: true });
  const info = await f.clock.settle(f.client.prepare());
  assert.equal(info.battery, 82);
  assert.equal(f.writes.length, 1);
  assert.ok(f.calls.every((call) => call.data.bleApiVersion === undefined));
  f.client.stop();
});
test("write capability is selected from discovery and short UUID fragmented replies decode", async () => {
  const f = fixture({ writeProperties: 0x1a, fragmented: true });
  const info = await f.clock.settle(f.client.prepare());
  assert.equal(info.battery, 82);
  assert.equal(f.writes[0].data.writeType, "withResponse");
  f.client.stop();
});
test("status-only native send failure is displayed by RN without response timeout", async () => {
  const f = fixture({ writeFail: true });
  await assert.rejects(f.clock.settle(f.client.prepare()), /蓝牙指令发送失败/);
  assert.equal(f.writes.length, 1);
  await f.clock.advance(7000);
  f.client.stop();
});
test("response timeout retries once and cleans up reply waiters", async () => {
  const f = fixture({ noResponse: true });
  await assert.rejects(
    f.clock.settle(f.client.prepare()),
    /读取设备信息响应超时/
  );
  assert.equal(f.writes.length, 2);
  f.client.stop();
  await f.clock.advance(7000);
});
test("offline download waits for D0D4 readiness as well as control readiness", async () => {
  const f = fixture();
  await f.clock.settle(f.client.prepare());
  const file = await f.clock.settle(
    f.client.downloadFile({ fileName: "20260922123456", size: 3 }, () => {})
  );
  assert.equal(file.size, 3);
  assert.ok(f.writes.find((w) => w.command === 8).offline);
  f.client.stop();
});
test("file-list end frame completes and polling responses from another device are ignored", async () => {
  const f = fixture();
  await f.clock.settle(f.client.prepare());
  const result = await f.clock.settle(f.client.queryFileList());
  assert.equal(result.length, 0);
  f.emit(2010, { macAddress: "another-device", connectStatus: 2 });
  assert.equal(f.client.isConnected(), true);
  f.client.stop();
});

test("Android keeps legacy bridge options and notification settling behavior", async () => {
  const f = fixture({ platform: "android" });
  await f.clock.settle(f.client.prepare());
  assert.equal(f.writes[0].notifying, true);
  assert.equal(f.writes[0].data.bleApiVersion, undefined);
  assert.equal(f.writes[0].data.writeType, undefined);
  assert.equal(f.calls.filter((c) => c.type === 1004).length, 1);
  f.client.stop();
});
test("Android initializes when the legacy notify Promise never settles", async () => {
  const f = fixture({ platform: "android", pendingNotifyPromise: true });
  const info = await f.clock.settle(f.client.prepare());
  assert.equal(info.battery, 82);
  assert.equal(f.writes[0].notifying, true);
  f.client.stop();
});
test("Android treats connecting status as progress, not a failed connection", async () => {
  const f = fixture({
    platform: "android",
    connected: false,
    connectingFirst: true,
  });
  await f.clock.settle(f.client.prepare());
  assert.equal(f.calls.filter((call) => call.type === 1009).length, 1);
  assert.equal(f.writes[0].command, protocol.COMMAND.DEVICE_INFO);
  f.client.stop();
});
test("Android verifies a stale launch connection before initializing BLE", async () => {
  const f = fixture({
    platform: "android",
    connected: false,
    launchConnected: true,
  });
  assert.equal(f.client.isConnected(), false);
  await f.clock.settle(f.client.prepare());
  assert.equal(f.calls.filter((call) => call.type === 1007).length, 1);
  assert.equal(f.calls.filter((call) => call.type === 1009).length, 1);
  assert.equal(f.calls.filter((call) => call.type === 1008).length, 0);
  f.client.stop();
});
test("Android waits for service discovery before requesting MTU", async () => {
  const f = fixture({
    platform: "android",
    connected: false,
    servicesReadyDelay: 600,
  });
  await f.clock.settle(f.client.prepare());
  const connect = f.calls.find((call) => call.type === 1009);
  const mtu = f.calls.find((call) => call.type === 1006);
  assert.ok(mtu.time - connect.time >= 600);
  assert.ok(f.calls.filter((call) => call.type === 1004).length > 1);
  assert.equal(f.calls.filter((call) => call.type === 1008).length, 0);
  f.client.stop();
});
test("Android reuses an existing native BLE link without issuing a second connect", async () => {
  const f = fixture({
    platform: "android",
    connected: true,
    launchConnected: false,
    pendingNotifyPromise: true,
    missingWriteCallback: true,
  });
  const info = await f.clock.settle(f.client.prepare());
  assert.equal(info.battery, 82);
  assert.equal(f.calls.filter((call) => call.type === 1009).length, 0);
  assert.equal(f.writes[0].command, protocol.COMMAND.DEVICE_INFO);
  f.client.stop();
});
test("Android reports a missing MTU callback without disconnecting or notifying", async () => {
  const f = fixture({
    platform: "android",
    connected: true,
    mtuOnlyAfterReconnect: true,
    pendingNotifyPromise: true,
  });
  await assert.rejects(f.clock.settle(f.client.prepare()), /MTU/);
  assert.equal(f.calls.filter((call) => call.type === 1008).length, 0);
  assert.equal(f.calls.filter((call) => call.type === 1009).length, 0);
  assert.equal(f.calls.filter((call) => call.type === 1003).length, 0);
  assert.equal(f.writes.length, 0);
  f.client.stop();
});
test("Android accepts a matching device reply when the write callback is absent", async () => {
  const f = fixture({
    platform: "android",
    pendingNotifyPromise: true,
    missingWriteCallback: true,
  });
  const info = await f.clock.settle(f.client.prepare());
  assert.equal(info.battery, 82);
  assert.equal(f.writes[0].command, protocol.COMMAND.DEVICE_INFO);
  const files = await f.clock.settle(f.client.queryFileList());
  assert.equal(files.length, 0);
  f.client.stop();
});
test("Android retains file records if only the list terminator is lost", async () => {
  const f = fixture({ platform: "android", missingFileListEnd: true });
  await f.clock.settle(f.client.prepare());
  const files = await f.clock.settle(f.client.queryFileList());
  assert.equal(files.length, 1);
  assert.equal(files[0].fileName, "20260915102115");
  f.client.stop();
});
test("late service query response cannot settle a different request", async () => {
  const f = fixture({ holdType: 1004 });
  const p = f.client.prepare();
  p.catch(() => {});
  await f.clock.advance(100);
  f.emit(2009, {
    mac: MAC,
    requestId: "old-request",
    services: [
      {
        uuid: protocol.UUIDS.service,
        chacs: [
          { uuid: protocol.UUIDS.write, properties: 0x16 },
          { uuid: protocol.UUIDS.control, properties: 0x1a, isNotifying: true },
        ],
      },
    ],
  });
  await assert.rejects(f.clock.settle(p), /查询蓝牙服务超时/);
  assert.equal(f.writes.length, 0);
  f.client.stop();
});
test("unsupported write characteristics and missing notify state fail before sending", async () => {
  for (const options of [
    { writeProperties: 2 },
    { missingNotifyField: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(
      f.clock.settle(f.client.prepare()),
      /不支持写入|不支持查询通知订阅状态/
    );
    assert.equal(f.writes.length, 0);
    f.client.stop();
  }
});

test("asynchronous rejection of the write bridge clears response timeout", async () => {
  const f = fixture({ rejectType: 1000 });
  await assert.rejects(f.clock.settle(f.client.prepare()), /bridge rejected/);
  await f.clock.advance(7000);
  assert.equal(f.writes.length, 0);
  f.client.stop();
});

test("closing and reopening the client invalidates the old preparation", async () => {
  const f = fixture({ neverNotify: true });
  const old = f.client.prepare();
  old.catch(() => {});
  await f.clock.advance(300);
  f.client.stop();
  f.client.start();
  await assert.rejects(
    f.clock.settle(old),
    (error) => error.code === "BLE_SESSION_CHANGED"
  );
  await f.clock.advance(7000);
  assert.equal(f.writes.length, 0);
  f.client.stop();
});

for (const platform of ["ios", "android"]) {
  test(`${platform}: download start keeps the original five-byte payload`, async () => {
    const f = fixture({ platform });
    await f.clock.settle(f.client.prepare());
    const result = await f.clock.settle(
      f.client.downloadFile({ fileName: "20260922123456", size: 3 }, () => {})
    );
    assert.equal(result.size, 3);
    const sent = f.writes.find((item) => item.command === 8).data.pkgs[0];
    assert.equal(
      sent,
      protocol.bytesToHex(protocol.buildFileDataRequest("20260922123456", 0))
    );
    f.client.stop();
  });
  test(`${platform}: one-byte download start does not satisfy the original protocol`, async () => {
    const f = fixture({ platform, invalidDownloadStart: true });
    await f.clock.settle(f.client.prepare());
    await assert.rejects(
      f.clock.settle(
        f.client.downloadFile({ fileName: "20260922123456", size: 3 }, () => {})
      ),
      /开始下载响应超时/
    );
    f.client.stop();
  });
  test(`${platform}: file list ignores state zero and accepts only the original end state`, async () => {
    const f = fixture({ platform, fileListStartState: true });
    await f.clock.settle(f.client.prepare());
    const files = await f.clock.settle(f.client.queryFileList());
    assert.equal(files.length, 0);
    f.client.stop();
  });
  test(`${platform}: file-list state one preserves the original failure result`, async () => {
    const f = fixture({ platform, fileListFail: true });
    await f.clock.settle(f.client.prepare());
    await assert.rejects(
      f.clock.settle(f.client.queryFileList()),
      /设备文件列表读取失败/
    );
    f.client.stop();
  });
}
