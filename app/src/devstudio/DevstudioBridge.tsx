/**
 * devstudio 포팅(RTM R-J26) — MIDI 편집 명령 다리. window.__midi
 * 앱 안에 붙는 보이지 않는 컴포넌트 — 사람 조작과 같은 훅(곡 교체·되돌리기 기록)과 core 도메인(Song·Track)을 평범한 값의 명령으로 노출한다.
 * devstudio 편집기 연결부(editors/web-mcp, 어댑터 signal)가 이 명령을 MCP 도구로 내보낸다(BYOAI). 소리 렌더(fluidsynth)는 연결부 몫.
 */
import {
  emptySong,
  emptyTrack,
  isNoteEvent,
  type NoteEvent,
  type Song,
  songFromMidi,
  songToMidi,
  type Track,
} from "@signal-app/core"
import { useEffect } from "react"
import { useSetSong } from "../actions/song"
import { useHistory } from "../hooks/useHistory"
import { useSong } from "../hooks/useSong"

type NoteIn = {
  tick: number
  pitch: number
  duration: number
  velocity?: number
}

const b64ToBytes = (b64: string) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
const bytesToB64 = (u8: Uint8Array) => {
  let s = ""
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  }
  return btoa(s)
}
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
const pitchName = (n: number) => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`

export const DevstudioBridge = () => {
  const { getSong } = useSong()
  const setSong = useSetSong()
  const { pushHistory, undo, redo } = useHistory()

  useEffect(() => {
    const song = (): Song => getSong()
    const playable = () => song().tracks.filter((t) => !t.isConductorTrack)
    const track = (i: number): Track => {
      const t = playable()[i]
      if (!t) {
        throw new Error(`트랙 ${i} 이 없습니다 — 0..${playable().length - 1}`)
      }
      return t
    }
    const notes = (t: Track) => t.events.filter(isNoteEvent) as NoteEvent[]
    const info = () => {
      const s = song()
      const c = s.conductorTrack
      return {
        name: s.name,
        timebase: s.timebase,
        tempo: c ? Math.round((c.getTempo(0) ?? 120) * 100) / 100 : null,
        endTick: Math.max(0, ...s.tracks.map((t) => t.endOfTrack)),
        tracks: playable().map((t, i) => ({
          index: i,
          name: t.name ?? "",
          channel: t.channel,
          program: t.getProgramChangeEvent(0)?.value ?? null,
          drums: t.isRhythmTrack,
          notes: notes(t).length,
        })),
      }
    }
    const edit = <T,>(fn: () => T): T => {
      pushHistory()
      return fn()
    }
    const api = {
      ready: () => !!song(),
      info,
      newSong: () => {
        setSong(emptySong())
        return info()
      },
      open: (b64: string, name?: string) => {
        const s = songFromMidi(b64ToBytes(b64))
        if (name) {
          s.name = name
        }
        setSong(s)
        return info()
      },
      midi: () => bytesToB64(songToMidi(song())),
      trackAdd: (program?: number, name?: string) =>
        edit(() => {
          const used = new Set(playable().map((t) => t.channel))
          const ch =
            [...Array(16).keys()].find((c) => c !== 9 && !used.has(c)) ?? 0
          const t = emptyTrack(ch)
          song().addTrack(t)
          if (program !== undefined) {
            t.setProgramNumberAt(0, program)
          }
          if (name) {
            t.setName(name)
          }
          return info()
        }),
      trackRemove: (i: number) =>
        edit(() => {
          song().removeTrack(track(i).id)
          return info()
        }),
      trackProgram: (i: number, program: number) =>
        edit(() => {
          track(i).setProgramNumberAt(0, program)
          return info()
        }),
      trackName: (i: number, name: string) =>
        edit(() => {
          track(i).setName(name)
          return info()
        }),
      notesGet: (i: number, from = 0, to = Number.MAX_SAFE_INTEGER) =>
        notes(track(i))
          .filter((n) => n.tick >= from && n.tick < to)
          .slice(0, 500)
          .map((n) => ({
            id: n.id,
            tick: n.tick,
            pitch: n.noteNumber,
            name: pitchName(n.noteNumber),
            duration: n.duration,
            velocity: n.velocity,
          })),
      notesAdd: (i: number, list: NoteIn[]) =>
        edit(() => {
          const t = track(i)
          t.addEvents(
            list.map((n) => ({
              type: "channel" as const,
              subtype: "note" as const,
              tick: Math.round(n.tick),
              duration: Math.max(1, Math.round(n.duration)),
              noteNumber: Math.max(0, Math.min(127, Math.round(n.pitch))),
              velocity: Math.max(
                1,
                Math.min(127, Math.round(n.velocity ?? 100)),
              ),
            })),
          )
          return { added: list.length, notes: notes(t).length }
        }),
      notesRemove: (i: number, ids?: number[], from?: number, to?: number) =>
        edit(() => {
          const t = track(i)
          const target = notes(t).filter((n) =>
            ids
              ? ids.includes(n.id)
              : n.tick >= (from ?? 0) &&
                n.tick < (to ?? Number.MAX_SAFE_INTEGER),
          )
          t.removeEvents(target.map((n) => n.id))
          return { removed: target.length, notes: notes(t).length }
        }),
      notesTranspose: (i: number, semis: number, from?: number, to?: number) =>
        edit(() => {
          const t = track(i)
          const target = notes(t).filter(
            (n) =>
              n.tick >= (from ?? 0) && n.tick < (to ?? Number.MAX_SAFE_INTEGER),
          )
          t.updateEvents(
            target.map((n) => ({
              id: n.id,
              noteNumber: Math.max(0, Math.min(127, n.noteNumber + semis)),
            })),
          )
          return { moved: target.length }
        }),
      quantize: (i: number, grid: number) =>
        edit(() => {
          const t = track(i)
          const g = Math.max(1, Math.round(grid))
          const target = notes(t)
          t.updateEvents(
            target.map((n) => ({ id: n.id, tick: Math.round(n.tick / g) * g })),
          )
          return { quantized: target.length, grid: g }
        }),
      tempo: (bpm: number) =>
        edit(() => {
          const c = song().conductorTrack
          if (!c) {
            throw new Error("지휘 트랙이 없습니다")
          }
          c.setTempo(bpm, 0)
          return info()
        }),
      undo: () => {
        undo()
        return info()
      },
      redo: () => {
        redo()
        return info()
      },
      // 피아노롤 PNG — 트랙별 색, 가로 = tick, 세로 = 음높이(사용된 범위)
      pianoroll: (width = 1200, height = 360) => {
        const all = playable().flatMap((t, ti) =>
          notes(t).map((n) => ({ n, ti })),
        )
        const c = document.createElement("canvas")
        c.width = width
        c.height = height
        const g = c.getContext("2d") as CanvasRenderingContext2D
        g.fillStyle = "#16191d"
        g.fillRect(0, 0, width, height)
        if (!all.length) {
          return c.toDataURL("image/png").split(",")[1]
        }
        const lo = Math.min(...all.map((x) => x.n.noteNumber)) - 1
        const hi = Math.max(...all.map((x) => x.n.noteNumber)) + 1
        const end = Math.max(...all.map((x) => x.n.tick + x.n.duration))
        const tb = song().timebase
        const rowH = height / (hi - lo + 1)
        g.strokeStyle = "#2a3038"
        for (let b = 0; b <= end; b += tb * 4) {
          const x = (b / end) * width
          g.beginPath()
          g.moveTo(x, 0)
          g.lineTo(x, height)
          g.stroke()
        }
        const colors = [
          "#7fd1a8",
          "#6aa5e8",
          "#e0a24a",
          "#e57f8a",
          "#b48ee0",
          "#d6d36a",
        ]
        for (const { n, ti } of all) {
          g.fillStyle = colors[ti % colors.length]
          g.fillRect(
            (n.tick / end) * width,
            height - (n.noteNumber - lo + 1) * rowH,
            Math.max(2, (n.duration / end) * width - 1),
            Math.max(2, rowH - 1),
          )
        }
        g.fillStyle = "#e4e7eb"
        g.font = "12px sans-serif"
        g.fillText(`${pitchName(hi)}`, 4, 12)
        g.fillText(`${pitchName(lo)}`, 4, height - 4)
        return c.toDataURL("image/png").split(",")[1]
      },
    }
    for (const k of Object.keys(api) as (keyof typeof api)[]) {
      const f = api[k] as (...a: unknown[]) => unknown
      ;(api as Record<string, unknown>)[k] = (...a: unknown[]) => {
        try {
          return f(...a)
        } catch (e) {
          throw new Error(String((e as Error)?.message ?? e))
        }
      }
    }
    ;(window as unknown as { __midi: typeof api }).__midi = api
  }, [getSong, setSong, pushHistory, undo, redo])

  return null
}
