//DEV NOTE : JUST SOLO ... USED FOR TESTING PUSHUPS WITH MEDIAPIPE MODEL

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { PoseLandmarker as PoseLandmarkerType } from "@mediapipe/tasks-vision";

type Status = "idle" | "loading" | "running" | "error";
type PushupPhase = "no_plank"|"top"|"descending"|"bottom"|"ascending";

const MODEL_PATH            = "/models/pose_landmarker_lite.task";
const WASM_PATH             = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const DETECTION_INTERVAL_MS = 66;

// ── Rep thresholds (front-facing: average of BOTH elbows) ──────────
const TOP_ELBOW    = 145;
const BOTTOM_ELBOW = 100;
const MIN_REP_MS   = 700;

// ── Position validation (front-facing) ─────────────────────────────
const VIS_MIN               = 0.4;
const SHOULDER_LEVEL_MAX    = 0.06; // max Y diff between shoulders
const WRIST_BELOW_ELBOW_MIN = 0.02; // wrist.y must be > elbow.y by this

const LM = {
  NOSE: 0,
  LEFT_SHOULDER: 11,  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,     RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,     RIGHT_WRIST: 16,
  LEFT_HIP: 23,       RIGHT_HIP: 24,
  LEFT_KNEE: 25,      RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,     RIGHT_ANKLE: 28,
};

type Landmark = { x:number; y:number; z:number; visibility?:number };
type CheckResult = { label:string; pass:boolean; value:string };

function vis(lm: Landmark) { return lm.visibility ?? 1; }

function angleDeg(a: Landmark, b: Landmark, c: Landmark) {
  const ab = { x:a.x-b.x, y:a.y-b.y };
  const cb = { x:c.x-b.x, y:c.y-b.y };
  const dot = ab.x*cb.x + ab.y*cb.y;
  const mag = Math.sqrt(ab.x**2+ab.y**2) * Math.sqrt(cb.x**2+cb.y**2);
  if (mag === 0) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot/mag))) * 180) / Math.PI;
}

// ── Front-facing position check ────────────────────────────────────
function checkFrontFacing(lms: Landmark[]): {
  ok: boolean; checks: CheckResult[]; avgElbow: number;
  allAngles: {
    leftElbow: number; rightElbow: number;
    leftKnee: number;  rightKnee: number;
    leftHip: number;   rightHip: number;
    leftKneeVis: number; rightKneeVis: number;
    leftAnkleVis: number; rightAnkleVis: number;
  };
} {
  const ls = lms[LM.LEFT_SHOULDER];
  const rs = lms[LM.RIGHT_SHOULDER];
  const le = lms[LM.LEFT_ELBOW];
  const re = lms[LM.RIGHT_ELBOW];
  const lw = lms[LM.LEFT_WRIST];
  const rw = lms[LM.RIGHT_WRIST];
  const lh = lms[LM.LEFT_HIP];
  const rh = lms[LM.RIGHT_HIP];
  const lk = lms[LM.LEFT_KNEE];
  const rk = lms[LM.RIGHT_KNEE];
  const la = lms[LM.LEFT_ANKLE];
  const ra = lms[LM.RIGHT_ANKLE];

  const leftElbow  = angleDeg(ls, le, lw);
  const rightElbow = angleDeg(rs, re, rw);
  const avgElbow   = Math.round((leftElbow + rightElbow) / 2);

  // Compute ALL angles for live display — helps calibration
  const leftKneeAngle  = Math.round(angleDeg(lh, lk, la));
  const rightKneeAngle = Math.round(angleDeg(rh, rk, ra));
  const leftHipAngle   = Math.round(angleDeg(ls, lh, lk));
  const rightHipAngle  = Math.round(angleDeg(rs, rh, rk));

  const allAngles = {
    leftElbow:  Math.round(leftElbow),
    rightElbow: Math.round(rightElbow),
    leftKnee:   leftKneeAngle,
    rightKnee:  rightKneeAngle,
    leftHip:    leftHipAngle,
    rightHip:   rightHipAngle,
    leftKneeVis:  Math.round(vis(lk) * 100),
    rightKneeVis: Math.round(vis(rk) * 100),
    leftAnkleVis:  Math.round(vis(la) * 100),
    rightAnkleVis: Math.round(vis(ra) * 100),
  };

  const checks: CheckResult[] = [];

  // 1. Key landmarks visible
  const keyVis = Math.min(vis(ls), vis(rs), vis(le), vis(re), vis(lw), vis(rw));
  const visOk  = keyVis >= VIS_MIN;
  checks.push({ label: "Body visible", pass: visOk,
    value: `vis: ${Math.round(keyVis * 100)}%` });
  if (!visOk) return { ok: false, checks, avgElbow, allAngles };

  // 2. Shoulders roughly level
  const shoulderDiff = Math.abs(ls.y - rs.y);
  const shouldersLevel = shoulderDiff < SHOULDER_LEVEL_MAX;
  checks.push({ label: "Shoulders level", pass: shouldersLevel,
    value: `diff: ${Math.round(shoulderDiff * 100)}%` });

  // 3. Wrists below elbows (hands on floor)
  const lwBelow = lw.y > le.y + WRIST_BELOW_ELBOW_MIN;
  const rwBelow = rw.y > re.y + WRIST_BELOW_ELBOW_MIN;
  const wristsDown = lwBelow && rwBelow;
  checks.push({ label: "Hands on floor", pass: wristsDown,
    value: wristsDown ? "✓" : "Place hands down" });

  // 4. Hips visible and below shoulders
  const hipVis = Math.min(vis(lh), vis(rh));
  const avgHipY = (lh.y + rh.y) / 2;
  const avgShoulderY = (ls.y + rs.y) / 2;
  const hipsOk = hipVis >= VIS_MIN && avgHipY > avgShoulderY;
  checks.push({ label: "Body position", pass: hipsOk,
    value: hipsOk ? "✓" : "Get into plank" });

  // 5. Body straight — use HIP angle (shoulder-hip-knee) instead of knee angle
  // From front view, knee angles are unreliable (legs foreshortened)
  // But HIP angle tells us if body is bent at the hip = kneeling
  // Kneeling: body pivots at hip → avg hip angle < 150°
  // Proper pushup: body is straight → avg hip angle ≥ 150°
  const HIP_STRAIGHT_MIN = 150;
  const avgHipAngle = Math.round((leftHipAngle + rightHipAngle) / 2);
  const kneesOk = avgHipAngle >= HIP_STRAIGHT_MIN;
  checks.push({
    label: "Body straight",
    pass: kneesOk,
    value: `hip ${avgHipAngle}° ${kneesOk ? "✓" : "— lift hips/legs"}`,
  });

  return { ok: visOk && shouldersLevel && wristsDown && hipsOk && kneesOk, checks, avgElbow, allAngles };
}

export default function PoseTestClient() {
  const videoRef      = useRef<HTMLVideoElement|null>(null);
  const canvasRef     = useRef<HTMLCanvasElement|null>(null);
  const streamRef     = useRef<MediaStream|null>(null);
  const landmarkerRef = useRef<PoseLandmarkerType|null>(null);
  const rafRef        = useRef<number|null>(null);

  const runningRef  = useRef(false);
  const lastDetectRef = useRef(0);
  const fpsCntRef   = useRef(0);
  const lastFpsRef  = useRef(performance.now());
  const phaseRef    = useRef<PushupPhase>("no_plank");
  const posOkRef    = useRef(false);
  const repCountRef = useRef(0);
  const lastRepRef  = useRef(0);

  const [status,     setStatus]     = useState<Status>("idle");
  const [message,    setMessage]    = useState("Click Start to test front-facing pushups.");
  const [fps,        setFps]        = useState(0);
  const [landmarks,  setLandmarks]  = useState(0);
  const [repCount,   setRepCount]   = useState(0);
  const [phase,      setPhase]      = useState<PushupPhase>("no_plank");
  const [positionOk, setPositionOk] = useState(false);
  const [checks,     setChecks]     = useState<CheckResult[]>([]);
  const [elbowAngle, setElbowAngle] = useState(0);
  const [allAngles,  setAllAngles]  = useState({
    leftElbow: 0, rightElbow: 0,
    leftKnee: 0,  rightKnee: 0,
    leftHip: 0,   rightHip: 0,
    leftKneeVis: 0, rightKneeVis: 0,
    leftAnkleVis: 0, rightAnkleVis: 0,
  });

  async function createLandmarker() {
    const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
    const opts = {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: "GPU" as const },
      runningMode: "VIDEO" as const, numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5, outputSegmentationMasks: false,
    };
    try   { return await PoseLandmarker.createFromOptions(vision, opts); }
    catch { return await PoseLandmarker.createFromOptions(vision,
              { ...opts, baseOptions: { modelAssetPath: MODEL_PATH, delegate: "CPU" as const } }); }
  }

  async function start() {
    try {
      setStatus("loading"); setMessage("Starting camera...");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 },
                 frameRate: { ideal: 30, max: 30 }, facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream; await video.play();
      setMessage("Loading pose model...");
      landmarkerRef.current = await createLandmarker();
      phaseRef.current = "no_plank"; posOkRef.current = false;
      repCountRef.current = 0; lastRepRef.current = 0;
      setRepCount(0); setPhase("no_plank"); setPositionOk(false);
      runningRef.current = true;
      setStatus("running"); setMessage("Face the camera and get into pushup position.");
      loop();
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to start.");
    }
  }

  function stop() {
    runningRef.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    landmarkerRef.current?.close();
    streamRef.current = null; landmarkerRef.current = null;
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    setStatus("idle"); setFps(0); setLandmarks(0);
    setPhase("no_plank"); setPositionOk(false); setMessage("Stopped.");
  }

  function resetCounter() {
    phaseRef.current = "no_plank"; posOkRef.current = false;
    repCountRef.current = 0; lastRepRef.current = 0;
    setRepCount(0); setPhase("no_plank"); setPositionOk(false);
  }

  function processPose(lms: Landmark[]) {
    const result = checkFrontFacing(lms);
    setChecks(result.checks);
    setElbowAngle(result.avgElbow);
    setAllAngles(result.allAngles);

    const wasOk = posOkRef.current;
    const nowOk = result.ok;
    posOkRef.current = nowOk;
    setPositionOk(nowOk);

    if (wasOk && !nowOk) { phaseRef.current = "no_plank"; setPhase("no_plank"); }
    if (!nowOk) return;

    const eAngle = result.avgElbow;
    const now    = performance.now();

    switch (phaseRef.current) {
      case "no_plank":
        if (eAngle >= TOP_ELBOW) { phaseRef.current = "top"; setPhase("top"); }
        break;
      case "top":
        if (eAngle < TOP_ELBOW - 15) { phaseRef.current = "descending"; setPhase("descending"); }
        break;
      case "descending":
        if (eAngle <= BOTTOM_ELBOW) { phaseRef.current = "bottom"; setPhase("bottom"); }
        else if (eAngle >= TOP_ELBOW) { phaseRef.current = "top"; setPhase("top"); }
        break;
      case "bottom":
        if (eAngle > BOTTOM_ELBOW + 10) { phaseRef.current = "ascending"; setPhase("ascending"); }
        break;
      case "ascending":
        if (eAngle >= TOP_ELBOW) {
          if (now - lastRepRef.current >= MIN_REP_MS) {
            repCountRef.current++; lastRepRef.current = now;
            setRepCount(repCountRef.current);
          }
          phaseRef.current = "top"; setPhase("top");
        } else if (eAngle <= BOTTOM_ELBOW) {
          phaseRef.current = "bottom"; setPhase("bottom");
        }
        break;
    }
  }

  function drawPose(lms: Landmark[], curPhase: PushupPhase, isOk: boolean) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!lms.length) return;
    const connections = [[11,12],[11,13],[13,15],[12,14],[14,16],
                         [11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
    const phaseColors: Record<PushupPhase,string> = {
      no_plank:"#ff2244", top:"#00ff88",
      descending:"#ffcc00", bottom:"#ff6644", ascending:"#44aaff",
    };
    const color = isOk ? phaseColors[curPhase] : "#ff2244";
    ctx.lineWidth = 5; ctx.strokeStyle = color; ctx.fillStyle = isOk ? "#ffffff" : "#ff6666";
    for (const [si, ei] of connections) {
      const a = lms[si], b = lms[ei];
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
      ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
      ctx.stroke();
    }
    for (const pt of lms) {
      ctx.beginPath();
      ctx.arc(pt.x * canvas.width, pt.y * canvas.height, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const loop = useCallback(() => {
    const video = videoRef.current, canvas = canvasRef.current, detector = landmarkerRef.current;
    if (!runningRef.current || !video || !canvas || !detector) return;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
      if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
      const now = performance.now();
      if (now - lastDetectRef.current >= DETECTION_INTERVAL_MS) {
        lastDetectRef.current = now;
        const result = detector.detectForVideo(video, now);
        const lms = (result.landmarks?.[0] ?? []) as Landmark[];
        setLandmarks(lms.length);
        drawPose(lms, phaseRef.current, posOkRef.current);
        if (lms.length > 0) processPose(lms);
        fpsCntRef.current++;
        const elapsed = now - lastFpsRef.current;
        if (elapsed >= 1000) {
          setFps(Math.round((fpsCntRef.current * 1000) / elapsed));
          fpsCntRef.current = 0; lastFpsRef.current = now;
        }
      }
    }
    rafRef.current = requestAnimationFrame(loop);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const phaseLabel: Record<PushupPhase,string> = {
    no_plank: "Get in position", top: "DOWN ↓",
    descending: "Going down...", bottom: "PUSH UP ↑", ascending: "Almost there...",
  };
  const phaseColor: Record<PushupPhase,string> = {
    no_plank: "#ff2244", top: "#00ff88",
    descending: "#ffcc00", bottom: "#ff6644", ascending: "#44aaff",
  };

  return (
    <main style={{
      minHeight: "100vh", background: "#080808", color: "white",
      padding: 16, fontFamily: "'DM Mono','Courier New',monospace",
    }}>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>

        <div style={{ marginBottom: 12 }}>
          <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: -1, margin: 0 }}>
            LOCKED&apos;N<span style={{ color: "#00ff88" }}>.</span>
          </h1>
          <p style={{ margin: "2px 0 0", opacity: 0.4, fontSize: 12 }}>
            Pushup Test · Front-facing
          </p>
        </div>

        <div style={{
          textAlign: "center", padding: "16px 0 10px", borderRadius: 16,
          background: "rgba(255,255,255,0.04)",
          border: `1px solid ${positionOk ? "rgba(0,255,136,0.2)" : "rgba(255,34,68,0.3)"}`,
          marginBottom: 12,
        }}>
          <div style={{
            fontSize: 88, fontWeight: 900, lineHeight: 1, letterSpacing: -4,
            color: repCount > 0 ? "#00ff88" : "rgba(255,255,255,0.12)",
          }}>{repCount}</div>
          <div style={{ fontSize: 12, opacity: 0.4, marginTop: 2 }}>REPS</div>
          <div style={{
            marginTop: 10, display: "inline-block", padding: "5px 14px", borderRadius: 30,
            fontSize: 12, fontWeight: 700, background: "rgba(0,0,0,0.5)",
            border: `1px solid ${phaseColor[phase]}44`, color: phaseColor[phase],
          }}>{phaseLabel[phase]}</div>
        </div>

        {status === "running" && (
          <div style={{ marginBottom: 12 }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "8px 12px", borderRadius: 10, marginBottom: 8,
              background: positionOk ? "rgba(0,255,136,0.08)" : "rgba(255,34,68,0.08)",
              border: `1px solid ${positionOk ? "rgba(0,255,136,0.3)" : "rgba(255,34,68,0.3)"}`,
            }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                            background: positionOk ? "#00ff88" : "#ff2244" }} />
              <div style={{ fontSize: 12, fontWeight: 700, color: positionOk ? "#00ff88" : "#ff2244" }}>
                {positionOk ? "POSITION VALID" : "INVALID POSITION"}
              </div>
              <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.6 }}>
                elbow: {elbowAngle}°
              </div>
            </div>
            <div style={{
              padding: "8px 12px", borderRadius: 10,
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
            }}>
              {checks.map((c, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "3px 0",
                  borderBottom: i < checks.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
                }}>
                  <span style={{ fontSize: 12 }}>{c.pass ? "✅" : "❌"}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, flex: 1,
                                 color: c.pass ? "#00ff88" : "#ff4466" }}>{c.label}</span>
                  <span style={{ fontSize: 11, opacity: 0.5 }}>{c.value}</span>
                </div>
              ))}
            </div>
            {/* ALL LIVE ANGLES — for calibration */}
            <div style={{
              padding: "8px 12px", borderRadius: 10, marginTop: 8,
              background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.06)",
            }}>
              <div style={{ fontSize: 10, opacity: 0.4, letterSpacing: 1, marginBottom: 6 }}>
                LIVE ANGLES (screenshot knees-on-floor and knees-off-floor)
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {[
                  { label: "L Elbow",      val: allAngles.leftElbow,    unit: "°" },
                  { label: "R Elbow",      val: allAngles.rightElbow,   unit: "°" },
                  { label: "L Knee",       val: allAngles.leftKnee,     unit: "°" },
                  { label: "R Knee",       val: allAngles.rightKnee,    unit: "°" },
                  { label: "L Hip",        val: allAngles.leftHip,      unit: "°" },
                  { label: "R Hip",        val: allAngles.rightHip,     unit: "°" },
                  { label: "L Knee vis",   val: allAngles.leftKneeVis,  unit: "%" },
                  { label: "R Knee vis",   val: allAngles.rightKneeVis, unit: "%" },
                  { label: "L Ankle vis",  val: allAngles.leftAnkleVis, unit: "%" },
                  { label: "R Ankle vis",  val: allAngles.rightAnkleVis,unit: "%" },
                ].map((a, i) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between",
                    padding: "2px 0", borderBottom: "1px solid rgba(255,255,255,0.04)",
                    fontSize: 11,
                  }}>
                    <span style={{ opacity: 0.5 }}>{a.label}</span>
                    <span style={{ fontWeight: 700, color: "#00ff88" }}>
                      {a.val}{a.unit}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div style={{
          position: "relative", width: "100%", aspectRatio: "4 / 3",
          background: "#111", borderRadius: 14, overflow: "hidden",
          border: `1px solid ${positionOk ? "rgba(0,255,136,0.2)" : "rgba(255,34,68,0.25)"}`,
          marginBottom: 12,
        }}>
          <video ref={videoRef} playsInline muted autoPlay style={{
            position: "absolute", inset: 0, width: "100%", height: "100%",
            objectFit: "cover", transform: "scaleX(-1)",
          }} />
          <canvas ref={canvasRef} style={{
            position: "absolute", inset: 0, width: "100%", height: "100%",
            transform: "scaleX(-1)",
          }} />
          <div style={{
            position: "absolute", top: 8, left: 8, padding: "6px 10px",
            borderRadius: 8, background: "rgba(0,0,0,0.75)", fontSize: 11, lineHeight: 1.5,
          }}>
            <div style={{ opacity: 0.5 }}>LM: {landmarks}/33 · {fps}fps</div>
            <div style={{ color: positionOk ? "#00ff88" : "#ff2244", fontWeight: 700 }}>
              {positionOk ? "● ACTIVE" : "● INVALID"}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button onClick={start} disabled={status === "loading" || status === "running"} style={{
            flex: 1, padding: "13px 0", borderRadius: 10, border: 0, fontWeight: 800, fontSize: 14,
            cursor: status === "loading" || status === "running" ? "not-allowed" : "pointer",
            background: status === "running" ? "rgba(0,255,136,0.15)" : "#00ff88",
            color: status === "running" ? "#00ff88" : "#000",
          }}>
            {status === "loading" ? "Loading..." : status === "running" ? "Running ✓" : "Start"}
          </button>
          <button onClick={stop} disabled={status !== "running" && status !== "loading"} style={{
            flex: 1, padding: "13px 0", borderRadius: 10, fontWeight: 800, fontSize: 14,
            border: "1px solid rgba(255,255,255,0.2)", cursor: "pointer",
            background: "transparent", color: "white",
          }}>Stop</button>
          <button onClick={resetCounter} disabled={status !== "running"} style={{
            padding: "13px 16px", borderRadius: 10, cursor: "pointer", fontWeight: 700, fontSize: 12,
            border: "1px solid rgba(255,255,255,0.1)", background: "transparent",
            color: "rgba(255,255,255,0.4)",
          }}>Reset</button>
        </div>

        <p style={{ opacity: 0.4, fontSize: 12, margin: "0 0 12px" }}>{message}</p>

        <div style={{
          padding: 12, borderRadius: 10, background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.06)", fontSize: 11, lineHeight: 1.8,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: "#00ff88", fontSize: 12 }}>
            Front-facing pushup detection
          </div>
          <div style={{ opacity: 0.6 }}>
            📱 Place phone in front of you so it sees your upper body.<br/>
            🤸 Get into pushup position facing the camera.<br/>
            ✅ Both arms must be visible with hands on the floor.<br/>
            🔴 Red = wrong position · 🟢 Green = counting reps.<br/>
            Uses average of BOTH elbow angles for accuracy.
          </div>
        </div>
      </div>
    </main>
  );
}
