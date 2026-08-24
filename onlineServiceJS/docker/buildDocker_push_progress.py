import re, select, sys, time

_FRAC = re.compile(
    r"([\d.]+)\s*([KMGTPk]?[bB])\s*/\s*([\d.]+)\s*([KMGTPk]?[bB])"
)


def fmt_sec(sec):
    if sec is None or sec < 0:
        return "--"
    sec = int(sec + 0.5)
    if sec >= 3600:
        return "%dh%02dm" % (sec // 3600, (sec % 3600) // 60)
    if sec >= 60:
        return "%dm%02ds" % (sec // 60, sec % 60)
    return "%ds" % sec


def to_bytes(val, unit):
    u = unit.replace("kB", "KB").replace("mB", "MB").upper()
    mult = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4, "PB": 1024**5}
    return float(val) * mult.get(u, 1024**2)


def main():
    start = time.monotonic()
    phase = {"t_export": None, "t_push": None, "name": "构建"}
    last_cur = last_tot = 0.0
    samples = []
    last_draw = 0.0

    def note_phase(line):
        low = line.lower()
        if "pushing layer" in low or "pushing layers" in low or "pushing manifest" in low:
            phase["name"] = "推送"
            if phase["t_push"] is None:
                phase["t_push"] = time.monotonic()
            return
        if "exporting to image" in low or "exporting layers" in low:
            phase["name"] = "导出镜像"
            if phase["t_export"] is None:
                phase["t_export"] = time.monotonic()
            return
        if "transferring context" in low or "resolve " in low:
            phase["name"] = "解析/上下文"
            return
        if "load build definition" in low or "load .dockerignore" in low:
            phase["name"] = "加载定义"
            return

    def ingest_line(line, now):
        nonlocal last_cur, last_tot
        note_phase(line)
        m = _FRAC.search(line)
        if not m:
            return
        try:
            c = to_bytes(m.group(1), m.group(2))
            t = to_bytes(m.group(3), m.group(4))
        except (ValueError, TypeError):
            return
        if t <= 0:
            return
        cur_b = min(c, t)
        if last_tot > 0 and abs(t - last_tot) / max(last_tot, 1) > 0.02:
            samples.clear()
        last_cur, last_tot = cur_b, t
        samples.append((now, cur_b))
        while len(samples) > 16:
            samples.pop(0)

    def draw(now, force=False):
        nonlocal last_draw
        if not force and now - last_draw < 0.2:
            return
        last_draw = now
        elapsed = now - start
        export_t, push_t = phase["t_export"], phase["t_push"]
        pname = phase["name"]

        pct_s = pname
        eta = None
        if last_tot > 0:
            pct = min(100.0, 100.0 * last_cur / last_tot)
            pct_s = "%s %.1f%%" % (pname, pct)
            if last_cur < last_tot and len(samples) >= 2:
                t0, c0 = samples[-2]
                t1, c1 = samples[-1]
                dt, dc = t1 - t0, c1 - c0
                if dt > 0.08 and dc > 0:
                    rate = dc / dt
                    if rate > 0:
                        eta = (last_tot - last_cur) / rate

        if eta is None and (push_t is not None or export_t is not None or pname in ("推送", "导出镜像")):
            phase_anchor = push_t or export_t or start
            ep = now - phase_anchor
            if ep >= 2:
                eta = max(15.0, ep * 1.5)

        line = (
            "[buildDocker.sh] 进度 %s | 已用时 %s | 预计剩余 %s"
            % (pct_s, fmt_sec(elapsed), fmt_sec(eta))
        )
        sys.stderr.write("\r\033[2K" + line)
        sys.stderr.flush()

    try:
        while True:
            r, _, _ = select.select([sys.stdin], [], [], 0.8)
            now = time.monotonic()
            if not r:
                draw(now)
                continue
            raw = sys.stdin.readline()
            if raw == "":
                break
            sys.stdout.write(raw)
            sys.stdout.flush()
            ingest_line(raw, now)
            draw(now)
    except KeyboardInterrupt:
        sys.stderr.write("\n")
        sys.stderr.flush()
        raise
    now = time.monotonic()
    draw(now, force=True)
    sys.stderr.write("\n")
    sys.stderr.flush()


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
