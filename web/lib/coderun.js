/* Coderun: runs the learner's Python or JavaScript against test cases, in a Web Worker
   (browser) or a child process / vm (Node, used by the tests), and grades the answers. */
(function (root) {
  "use strict";
  const Tasks = root.Codetasks || (typeof require !== "undefined" ? require("./codetasks.js") : null);
  const PYODIDE_BASE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
  const PY_HARNESS = [
    "import json, io, contextlib",
    "def _run(code, fname, cases):",
    "    buf = io.StringIO()",
    "    ns = {'__name__': '__solution__'}",
    "    with contextlib.redirect_stdout(buf):",
    "        try:",
    "            exec(compile(code, 'solution.py', 'exec'), ns)",
    "        except BaseException as e:",
    "            return json.dumps({'ok': False, 'error': type(e).__name__ + ': ' + str(e)})",
    "        f = ns.get(fname)",
    "        if not callable(f):",
    "            return json.dumps({'ok': False, 'error': 'Define a function named ' + fname})",
    "        out = []",
    "        for args in cases:",
    "            try:",
    "                r = f(*json.loads(json.dumps(args)))",
    "                out.append({'got': json.loads(json.dumps(r))})",
    "            except BaseException as e:",
    "                out.append({'error': type(e).__name__ + ': ' + str(e)})",
    "    return json.dumps({'ok': True, 'results': out, 'stdout': buf.getvalue()[:2000]})",
  ].join("\n");
  const JS_WORKER = `self.onmessage = function (e) {
    var d = e.data, logs = [], con = { log: function () { logs.push(Array.prototype.slice.call(arguments).map(String).join(" ")); } }, fn;
    try { fn = new Function("console", d.code + "\\nreturn typeof " + d.fname + " === 'function' ? " + d.fname + " : undefined;")(con); }
    catch (err) { postMessage({ ok: false, error: String(err) }); return; }
    if (!fn) { postMessage({ ok: false, error: "Define a function named " + d.fname }); return; }
    var results = [];
    for (var i = 0; i < d.cases.length; i++) {
      try { var r = fn.apply(null, JSON.parse(JSON.stringify(d.cases[i]))); results.push({ got: r === undefined ? null : JSON.parse(JSON.stringify(r)), undef: r === undefined }); }
      catch (err) { results.push({ error: String(err) }); }
    }
    postMessage({ ok: true, results: results, stdout: logs.join("\\n").slice(0, 2000) });
  };`;
  const PY_WORKER = `var py = null, loading = null;
  self.onmessage = async function (e) {
    var d = e.data;
    try {
      if (!py) { if (!loading) { importScripts("${PYODIDE_BASE}pyodide.js"); loading = loadPyodide({ indexURL: "${PYODIDE_BASE}" }); } py = await loading; postMessage({ status: "ready" }); }
      py.globals.set("_code", d.code); py.globals.set("_fname", d.fname); py.globals.set("_cases", JSON.stringify(d.cases));
      var res = py.runPython(${JSON.stringify(PY_HARNESS)} + "\\n_run(_code, _fname, json.loads(_cases))");
      postMessage(JSON.parse(res));
    } catch (err) { postMessage({ ok: false, error: String(err && err.message || err).split("\\n").slice(-4).join("\\n") }); }
  };`;

  // ---------------------------------------------------------------- browser runner
  function browserRunner(opts) {
    const o = opts || {}, W = o.Worker || root.Worker, blob = (s) => root.URL.createObjectURL(new root.Blob([s], { type: "text/javascript" }));
    let pyW = null, status = () => {};
    const kill = (w) => { try { w.terminate(); } catch (e) { /* already gone */ } };
    function exec(worker, msg, ms, onStatus) {
      return new Promise((resolve) => {
        const t = setTimeout(() => { resolve({ ok: false, timedOut: true, error: "Your code ran for more than " + Math.round(ms / 1000) + " seconds. Check for an infinite loop." }); }, ms);
        worker.onmessage = (e) => { if (e.data && e.data.status) { if (onStatus) onStatus(e.data.status); return; } clearTimeout(t); resolve(e.data); };
        worker.onerror = (e) => { clearTimeout(t); resolve({ ok: false, error: String(e.message || "worker error") }); };
        worker.postMessage(msg);
      });
    }
    return {
      onStatus(f) { status = f; },
      async run(lang, code, fname, cases) {
        if (!W) return { ok: false, error: "This browser cannot run code workers." };
        if (lang === "js") { const w = new W(blob(JS_WORKER)); const r = await exec(w, { code, fname, cases }, 5000); kill(w); return r; }
        if (!pyW) { pyW = new W(blob(PY_WORKER)); pyW.fresh = true; }
        status(pyW.fresh ? "loading" : "running"); pyW.fresh = false;
        const r = await exec(pyW, { code, fname, cases }, o.pyTimeout || 90000, (s) => status(s));
        if (r.timedOut || (r.ok === false && /Failed to fetch|importScripts|NetworkError|loadPyodide/.test(r.error || ""))) { kill(pyW); pyW = null; if (!r.timedOut) r.error = "Python could not be loaded (it needs to download the Python runtime once, about 10 MB, from cdn.jsdelivr.net). Check your connection or use JavaScript."; }
        status("idle"); return r;
      },
    };
  }
  // ---------------------------------------------------------------- Node runner (tests)
  function nodeRunner() {
    const cp = require("child_process"), vm = require("vm");
    return {
      async run(lang, code, fname, cases) {
        if (lang === "js") {
          const logs = [], con = { log: (...a) => logs.push(a.map(String).join(" ")) };
          let fn; try { fn = vm.runInNewContext(code + "\n;typeof " + fname + " === 'function' ? " + fname + " : undefined;", { console: con }, { timeout: 2000 }); } catch (e) { return { ok: false, error: String(e) }; }
          if (!fn) return { ok: false, error: "Define a function named " + fname };
          const results = [];
          for (const a of cases) { try { const ctx = vm.createContext({ fn, a: JSON.stringify(a) }); const s = vm.runInContext("(function(){var r = fn.apply(null, JSON.parse(a)); return r === undefined ? 'null' : JSON.stringify(r);})()", ctx, { timeout: 1000 }); results.push({ got: JSON.parse(s) }); } catch (e) { results.push({ error: String(e && e.message || e) }); } }
          return { ok: true, results, stdout: logs.join("\n") };
        }
        const script = PY_HARNESS + "\nimport sys\nd = json.load(sys.stdin)\nprint(_run(d['code'], d['fname'], d['cases']))\n";
        const r = cp.spawnSync("python3", ["-I", "-c", script], { input: JSON.stringify({ code, fname, cases }), timeout: 10000, encoding: "utf8" });
        if (r.error && r.error.code === "ETIMEDOUT") return { ok: false, timedOut: true, error: "Your code ran too long." };
        if (r.status !== 0) return { ok: false, error: (r.stderr || "python failed").split("\n").slice(-3).join("\n") };
        return JSON.parse(r.stdout);
      },
    };
  }
  // ---------------------------------------------------------------- grading
  async function grade(task, lang, code, runner, o) {
    const opts = o || {}, fname = task.names[lang];
    const cases = Tasks.visibleCases(task).concat(opts.visibleOnly ? [] : Tasks.hiddenCases(task, opts.seed || (Date.now() % 100000), 10));
    const r = await runner.run(lang, code, fname, cases.map((c) => c.args));
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || "The code could not be run.", timedOut: !!(r && r.timedOut) };
    const out = cases.map((c, i) => { const x = r.results[i] || { error: "no result" }, pass = !x.error && Tasks.cmp(x.got, c.expected); return { kind: c.kind, pass, args: c.args, expected: c.expected, got: x.got, error: x.error, undef: x.undef }; });
    const first = out.findIndex((x) => !x.pass);
    return { ok: true, cases: out, passed: out.filter((x) => x.pass).length, total: out.length, allPassed: first < 0, firstFail: first < 0 ? null : first, stdout: r.stdout || "" };
  }
  const api = { grade, browserRunner, nodeRunner, PY_HARNESS, JS_WORKER, PY_WORKER, PYODIDE_BASE };
  root.Coderun = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
