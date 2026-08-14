"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Note = { raw: string; pitches: string[]; duration: number; dotted: boolean; tied: boolean; beats: number; measure: number; midis: number[] };
type Measure = { notes: Note[]; beats: number; invalid: string[]; status: "complete" | "under" | "over" | "invalid" };
type ChordDefinition = { name: string; pitches: string[] };
type Song = { id: string; notation: string; title: string; bpm: number; timeSignature: string; keySignature: string; chordDefinitions: string };

const initial = "E4/8 F#4/8 G4/4 B4/4 A4/4 | G4/8 E4/8 D4/4 E4/2 | r/4 E4/8 G4/8 B4/4 A4/4";
const semis: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const timeSignatures = ["2/4", "3/4", "4/4", "5/4", "2/8", "3/8", "5/8", "6/8", "7/8", "8/8", "9/8", "10/8", "11/8", "12/8", "13/8"];
const keySignatures = ["C", "G", "D", "A", "E", "B", "F#", "C#", "F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"];
const newSong = (id = `song-${Date.now()}`): Song => ({ id, notation: "", title: "Untitled composition", bpm: 92, timeSignature: "4/4", keySignature: "C", chordDefinitions: "" });

function beatsPerBar(signature: string) {
  const [count, unit] = signature.split("/").map(Number);
  return count * (4 / unit);
}

function pitchToMidi(pitch: string) {
  const match = pitch.match(/^([A-G])([#b]?)(\d)$/);
  if (!match) return null;
  return 12 * (Number(match[3]) + 1) + semis[match[1]] + (match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0);
}

function parseChordDefinitions(input: string) {
  const definitions: ChordDefinition[] = [];
  const errors: string[] = [];
  const names = new Set<string>();
  input.split(/\r?\n|;/).map(line => line.trim()).filter(Boolean).forEach(line => {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_+#-]*)\s*=\s*\[([^\]]+)\]$/);
    if (!match) { errors.push(`Invalid definition: ${line}`); return; }
    const pitches = match[2].split(",").map(pitch => pitch.trim()).filter(Boolean);
    if (!pitches.length || pitches.some(pitch => !/^[A-G](?:#|b)?\d$/.test(pitch))) { errors.push(`Invalid pitches in ${match[1]}`); return; }
    if (names.has(match[1])) { errors.push(`Duplicate chord name: ${match[1]}`); return; }
    names.add(match[1]);
    definitions.push({ name: match[1], pitches });
  });
  return { definitions, errors, chords: Object.fromEntries(definitions.map(definition => [definition.name, definition.pitches])) as Record<string, string[]> };
}

function parseComposition(input: string, barCapacity: number, chords: Record<string, string[]> = {}): Measure[] {
  const barStrings = input.split("|");
  while (barStrings.length > 1 && !barStrings.at(-1)?.trim()) barStrings.pop();
  return barStrings.map((bar, measure) => {
    const invalid: string[] = [];
    const notes = bar.trim().split(/\s+/).filter(Boolean).flatMap((raw): Note[] => {
      const match = raw.match(/^(.+)\/(1|2|4|8|16|32)(\.)?(~)?$/);
      if (!match) { invalid.push(raw); return []; }
      const duration = Number(match[2]);
      const dotted = Boolean(match[3]);
      const tied = Boolean(match[4]);
      const source = match[1];
      const rest = source.toLowerCase() === "r";
      if (rest && tied) { invalid.push(raw); return []; }
      let pitches: string[] = [];
      if (!rest && /^\[(?:[A-G](?:#|b)?\d)(?:,[A-G](?:#|b)?\d)+\]$/.test(source)) pitches = source.slice(1, -1).split(",");
      else if (!rest && /^[A-G](?:#|b)?\d$/.test(source)) pitches = [source];
      else if (!rest && chords[source]) pitches = chords[source];
      else if (!rest) { invalid.push(raw); return []; }
      const midis = pitches.map(pitchToMidi).filter((midi): midi is number => midi !== null);
      return [{ raw, pitches, duration, dotted, tied, beats: (4 / duration) * (dotted ? 1.5 : 1), measure, midis }];
    });
    const beats = notes.reduce((sum, note) => sum + note.beats, 0);
    const status = invalid.length ? "invalid" : beats > barCapacity ? "over" : beats < barCapacity ? "under" : "complete";
    return { notes, beats, invalid, status };
  });
}

function restsFor(beats: number) {
  const values = [{ beats: 4, token: "r/1" }, { beats: 2, token: "r/2" }, { beats: 1, token: "r/4" }, { beats: .5, token: "r/8" }, { beats: .25, token: "r/16" }, { beats: .125, token: "r/32" }];
  const rests: string[] = [];
  let remaining = Math.round(beats * 8) / 8;
  values.forEach(value => { while (remaining >= value.beats) { rests.push(value.token); remaining -= value.beats; } });
  return rests;
}

function tone(ctx: AudioContext, midi: number, start: number, length: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.22, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + Math.max(0.08, length - 0.025));
  osc.connect(gain).connect(ctx.destination);
  osc.start(start); osc.stop(start + length);
}

function EngravedScore({ measures, active, bpm, timeSignature, keySignature }: { measures: Measure[]; active: number; bpm: number; timeSignature: string; keySignature: string }) {
  const scoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void import("vexflow").then(({ Accidental, Barline, Beam, Dot, Formatter, Fraction, Renderer, Stave, StaveNote, StaveTie, Voice }) => {
      if (cancelled || !scoreRef.current) return;
      const host = scoreRef.current;
      host.replaceChildren();
      const densityWidths = measures.map((measure, index) => Math.max(index === 0 ? 330 : 270, 74 + measure.notes.length * 48));
      const minimumWidth = densityWidths.reduce((sum, value) => sum + value, 0) + 24;
      const availableWidth = Math.max(0, host.parentElement?.clientWidth ?? 0);
      const width = Math.max(minimumWidth, availableWidth);
      const height = 190;
      host.style.width = `${width}px`;
      host.style.minWidth = `${width}px`;
      const renderer = new Renderer(host, Renderer.Backends.SVG);
      renderer.resize(width, height);
      const context = renderer.getContext();
      context.setFillStyle("#18201c");
      context.setStrokeStyle("#18201c");
      let x = 12;
      let globalIndex = 0;
      let previous: { note: InstanceType<typeof StaveNote>; tied: boolean; pitches: string[] } | null = null;

      let renderFailed = false;
      measures.forEach((measure, measureIndex) => {
        const extra = Math.max(0, (width - minimumWidth) / Math.max(1, measures.length));
        const staveWidth = densityWidths[measureIndex] + extra;
        const stave = new Stave(x, 48, staveWidth);
        if (measureIndex === 0) stave.addClef("treble").addKeySignature(keySignature).addTimeSignature(timeSignature).setTempo({ duration: "q", bpm }, -5);
        else stave.setBegBarType(Barline.type.NONE);
        stave.setContext(context).draw();

        if (measure.notes.length) {
          const pendingTies: InstanceType<typeof StaveTie>[] = [];
          const vexNotes = measure.notes.map(note => {
            const durationMap: Record<number, string> = { 1: "w", 2: "h", 4: "q", 8: "8", 16: "16", 32: "32" };
            const keys = note.pitches.length ? note.pitches.map(pitch => `${pitch[0].toLowerCase()}${pitch.match(/[#b]/)?.[0] || ""}/${pitch.at(-1)}`) : ["b/4"];
            const staveNote = new StaveNote({ clef: "treble", keys, duration: `${durationMap[note.duration]}${note.midis.length ? "" : "r"}`, dots: note.dotted ? 1 : 0, autoStem: true });
            if (note.dotted) Dot.buildAndAttach([staveNote], { all: true });
            if (globalIndex === active) staveNote.setStyle({ fillStyle: "#1d5c45", strokeStyle: "#1d5c45" });
            globalIndex++;
            if (previous?.tied && previous.pitches.join(",") === note.pitches.join(",") && note.pitches.length) {
              pendingTies.push(new StaveTie({ firstNote: previous.note, lastNote: staveNote, firstIndexes: note.pitches.map((_, i) => i), lastIndexes: note.pitches.map((_, i) => i) }));
            }
            previous = { note: staveNote, tied: note.tied, pitches: note.pitches };
            return staveNote;
          });
          try {
            const [numBeats, beatValue] = timeSignature.split("/").map(Number);
            const voice = new Voice({ numBeats, beatValue }).setMode(Voice.Mode.SOFT).addTickables(vexNotes);
            Accidental.applyAccidentals([voice], keySignature);
            const beams = Beam.applyAndGetBeams(voice, undefined, [new Fraction(1, 4)]);
            new Formatter().joinVoices([voice]).formatToStave([voice], stave, { stave, context, alignRests: true });
            voice.draw(context, stave);
            beams.forEach(beam => beam.setContext(context).draw());
            pendingTies.forEach(tie => tie.setContext(context).draw());
          } catch {
            renderFailed = true;
          }
        }
        x += staveWidth;
      });

      host.toggleAttribute("data-render-error", renderFailed);
      const svg = host.querySelector("svg");
      svg?.setAttribute("aria-label", "Engraved treble-clef notation");
      if (svg) { svg.style.width = `${width}px`; svg.style.height = `${height}px`; svg.style.maxWidth = "none"; }
    });
    return () => { cancelled = true; };
  }, [measures, active, bpm, timeSignature, keySignature]);

  return <div className="engravedScore" ref={scoreRef} />;
}

export default function Home() {
  const [songs, setSongs] = useState<Song[]>([newSong("song-1")]);
  const [activeSongId, setActiveSongId] = useState("song-1");
  const [notation, setNotation] = useState(initial);
  const [title, setTitle] = useState("Untitled riff");
  const [bpm, setBpm] = useState(92);
  const [timeSignature, setTimeSignature] = useState("4/4");
  const [keySignature, setKeySignature] = useState("C");
  const [chordDefinitions, setChordDefinitions] = useState("AM = [A3,E4,A4,C#5,E5]");
  const [playing, setPlaying] = useState(false);
  const [active, setActive] = useState(-1);
  const [help, setHelp] = useState(false);
  const [loop, setLoop] = useState(false);
  const [saved, setSaved] = useState(true);
  const [fileMessage, setFileMessage] = useState("");
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState("Untitled riff");
  const [clearOpen, setClearOpen] = useState(false);
  const timers = useRef<number[]>([]);
  const audio = useRef<AudioContext | null>(null);
  const loopRef = useRef(loop);
  const fileInput = useRef<HTMLInputElement>(null);
  const hydrated = useRef(false);
  const chordLibrary = useMemo(() => parseChordDefinitions(chordDefinitions), [chordDefinitions]);
  const barCapacity = beatsPerBar(timeSignature);
  const measures = useMemo(() => parseComposition(notation, barCapacity, chordLibrary.chords), [notation, barCapacity, chordLibrary.chords]);
  const notes = useMemo(() => measures.flatMap(measure => measure.notes), [measures]);
  const printSystems = useMemo(() => {
    const systems: Measure[][] = [];
    let current: Measure[] = [];
    let width = 0;
    measures.forEach(measure => {
      const estimatedWidth = Math.max(270, 74 + measure.notes.length * 48);
      if (current.length && width + estimatedWidth > 900) { systems.push(current); current = []; width = 0; }
      current.push(measure);
      width += estimatedWidth;
    });
    if (current.length) systems.push(current);
    return systems;
  }, [measures]);
  const totalBeats = notes.reduce((sum, note) => sum + note.beats, 0);
  const allComplete = measures.length > 0 && measures.every(measure => measure.status === "complete");
  const hasBlockingErrors = measures.some(measure => measure.status === "over" || measure.status === "invalid");
  const atBarBoundary = /\|\s*$/.test(notation);
  const canDotLast = /\/(?:1|2|4|8|16)(?!\.)(?=\s*$)/.test(notation);
  const canTieLast = /(?:[A-G](?:#|b)?\d|\[[^\]]+\]|[A-Za-z][A-Za-z0-9_+#-]*)\/(?:1|2|4|8|16|32)\.?(?=\s*$)/.test(notation) && !/(?:^|\s)r\/(?:1|2|4|8|16|32)\.?$/i.test(notation.trim()) && !/~\s*$/.test(notation);

  useEffect(() => { loopRef.current = loop; }, [loop]);
  useEffect(() => {
    const restore = window.setTimeout(() => {
      try {
        const storedSongs = window.localStorage.getItem("notely-songs");
        const legacy = window.localStorage.getItem("notely-composition");
        const parsedSongs = storedSongs ? JSON.parse(storedSongs) as { songs: Song[]; activeSongId: string } : null;
        const legacySong = legacy ? { ...newSong("song-1"), ...JSON.parse(legacy), id: "song-1" } : { ...newSong("song-1"), notation: initial, title: "Untitled riff", chordDefinitions: "AM = [A3,E4,A4,C#5,E5]" };
        const restoredSongs = parsedSongs?.songs?.length ? parsedSongs.songs : [legacySong];
        const restoredId = restoredSongs.some(song => song.id === parsedSongs?.activeSongId) ? parsedSongs!.activeSongId : restoredSongs[0].id;
        const activeSong = restoredSongs.find(song => song.id === restoredId)!;
        setSongs(restoredSongs); setActiveSongId(restoredId); setNotation(activeSong.notation); setTitle(activeSong.title); setBpm(activeSong.bpm); setTimeSignature(activeSong.timeSignature); setKeySignature(activeSong.keySignature); setChordDefinitions(activeSong.chordDefinitions);
      } catch { /* keep the safe example */ }
      hydrated.current = true;
    }, 0);
    return () => clearTimeout(restore);
  }, []);
  useEffect(() => {
    if (!hydrated.current) return;
    const timer = window.setTimeout(() => {
      setSongs(current => {
        const updated = current.map(song => song.id === activeSongId ? { id: activeSongId, notation, title, bpm, timeSignature, keySignature, chordDefinitions } : song);
        window.localStorage.setItem("notely-songs", JSON.stringify({ songs: updated, activeSongId }));
        return updated;
      });
      setSaved(true);
    }, 400);
    return () => clearTimeout(timer);
  }, [notation, title, bpm, timeSignature, keySignature, chordDefinitions, activeSongId]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); void audio.current?.close(); }, []);

  const stop = () => {
    timers.current.forEach(clearTimeout); timers.current = [];
    void audio.current?.close(); audio.current = null;
    setPlaying(false); setActive(-1);
  };

  const schedulePlayback = () => {
    const ctx = new AudioContext();
    audio.current = ctx;
    const secondPerBeat = 60 / Math.min(220, Math.max(40, bpm));
    let cursor = 0;
    setPlaying(true);
    notes.forEach((note, index) => {
      const length = note.beats * secondPerBeat;
      const previousNote = notes[index - 1];
      const continuesTie = Boolean(previousNote?.tied && previousNote.midis.join(",") === note.midis.join(","));
      if (!continuesTie) {
        let tiedLength = length;
        let chain = index;
        while (notes[chain]?.tied && notes[chain + 1]?.midis.join(",") === note.midis.join("çkh‘éì¶»§q«^w˜İ\œ™[[YH
Èİ\œÛÜˆ
ÈŒYY[™İ
ˆMŠJNÂˆBˆ[Y\œË˜İ\œ™[œ\Ú
Ú[™İËœÙ][Y[İ]


HOˆÙ]Xİ]™J[™^
Kİ\œÛÜˆ
ˆL
JNÂˆİ\œÛÜˆ
ÏH[™İÂˆJNÂˆ[Y\œË˜İ\œ™[œ\Ú
Ú[™İËœÙ][Y[İ]


HOˆÂˆ[Y\œË˜İ\œ™[H×NÂˆ›ÚYİ˜ÛÜÙJ
NÂˆYˆ
ÛÜ™Y‹˜İ\œ™[
HØÚY[T^X˜XÚÊ
NÈ[ÙHÈ]Y[Ë˜İ\œ™[H[ÈÙ]^Z[™Ê˜[ÙJNÈÙ]Xİ]™JLJNÈBˆKİ\œÛÜˆ
ˆL
ÈL
JNÂˆNÂ‚ˆÛÛœİ^HH

HOˆÈYˆ
^Z[™ÊHİÜ

NÈ[ÙHØÚY[T^X˜XÚÊ
NÈNÂˆÛÛœİİ\œ™[ÛÛ™ÈH

NˆÛÛ™ÈOˆ
ÈYˆXİ]™TÛÛ™ÒY›İ][Û‹]KœK[YTÚYÛ˜]\™KÙ^TÚYÛ˜]\™KÚÜ™Yš[š][ÛœÈJNÂˆÛÛœİØYÛÛ™ÈH
ÛÛ™ÎˆÛÛ™ÊHOˆÂˆİÜ

NÈÙ]Xİ]™TÛÛ™ÒY
ÛÛ™ËšY
NÈÙ]›İ][ÛŠÛÛ™Ë››İ][ÛŠNÈÙ]]JÛÛ™Ë]JNÈÙ]œJÛÛ™Ë˜œJNÈÙ][YTÚYÛ˜]\™JÛÛ™Ë[YTÚYÛ˜]\™JNÈÙ]Ù^TÚYÛ˜]\™JÛÛ™ËšÙ^TÚYÛ˜]\™JNÈÙ]ÚÜ™Yš[š][ÛœÊÛÛ™Ë˜ÚÜ™Yš[š][ÛœÊNÈÙ]š[SY\ÜØYÙJˆŠNÈÙ]Ø]™Y
YJNÂˆNÂˆÛÛœİİÚ]ÚÛÛ™ÈH
Yˆİš[™ÊHOˆÂˆYˆ
YOOHXİ]™TÛÛ™ÒY
H™]\›ÂˆÛÛœİ\™Ù]HÛÛ™ÜË™š[™
ÛÛ™ÈOˆÛÛ™ËšYOOHY
NÂˆYˆ
]\™Ù]
H™]\›ÂˆÙ]ÛÛ™ÜÊİ\œ™[Oˆİ\œ™[›X\
ÛÛ™ÈOˆÛÛ™ËšYOOHXİ]™TÛÛ™ÒYÈİ\œ™[ÛÛ™Ê
HˆÛÛ™ÊJNÂˆØYÛÛ™Ê\™Ù]
NÂˆNÂˆÛÛœİYÛÛ™ÈH

HOˆÂˆÛÛœİÛÛ™ÈH™]ÔÛÛ™Ê
NÂˆÙ]ÛÛ™ÜÊİ\œ™[OˆË‹‹˜İ\œ™[›X\
][HOˆ][KšYOOHXİ]™TÛÛ™ÒYÈİ\œ™[ÛÛ™Ê
Hˆ][JKÛÛ™×JNÂˆØYÛÛ™ÊÛÛ™ÊNÂˆNÂˆÛÛœİÛX\”ÛÛ™ÈH

HOˆÂˆİÜ

NÈÙ]›İ][ÛŠˆŠNÈÙ]]J•[]YÛÛ\ÜÚ][ÛˆŠNÈÙ]œJLŠNÈÙ][YTÚYÛ˜]\™JÍŠNÈÙ]Ù^TÚYÛ˜]\™JÈŠNÈÙ]ÚÜ™Yš[š][ÛœÊˆŠNÈÙ]š[SY\ÜØYÙJˆŠNÈÙ]ÛX\“Ü[Š˜[ÙJNÈÙ]Ø]™Y
˜[ÙJNÂˆNÂˆÛÛœİš[ÛÛ\ÜÚ][ÛˆH

HOˆÂˆİÜ

NÂˆÚ[™İËœš[

NÂˆNÂˆÛÛœİÚ[™ÙS›İ][ÛˆH
˜[YNˆİš[™ÊHOˆÈÙ]Ø]™Y
˜[ÙJNÈÙ]›İ][ÛŠ˜[YJNÈNÂˆÛÛœİ[œÙ\H
˜[YNˆİš[™ÊHOˆÈÙ]Ø]™Y
˜[ÙJNÈÙ]›İ][ÛŠİ\œ™[Oˆ	Øİ\œ™[š[J
_H	İ˜[Y_Xš[J
JNÈNÂˆÛÛœİİ\İH

HOˆÂˆYˆ
XØ[‘İ\İ
H™]\›ÂˆÙ]Ø]™Y
˜[ÙJNÂˆÙ]›İ][ÛŠİ\œ™[Oˆİ\œ™[œ™\XÙJÊÊÎŒ_ŸMŠJJÏWÊ‰
KË‰KˆŠJNÂˆNÂˆÛÛœİYS\İH

HOˆÂˆYˆ
XØ[•YS\İ
H™]\›ÂˆÙ]Ø]™Y
˜[ÙJNÂˆÙ]›İ][ÛŠİ\œ™[Oˆ	Øİ\œ™[š[J
__˜
NÂˆNÂˆÛÛœİÛÛ\]P˜\ˆH

HOˆÂˆYˆ
]˜\›İ[™\JH™]\›ÂˆÛÛœİİ\œ™[HYX\İ\™\Ë˜]
LJHNÂˆYˆ
İ\œ™[œİ]\ÈOOH›İ™\ˆˆİ\œ™[œİ]\ÈOOHš[˜[YŠH™]\›ÂˆÛÛœİ™\İÈH™\İÑ›ÜŠ˜\Ø\XÚ]HHİ\œ™[˜™X]ÊNÂˆÙ]Ø]™Y
˜[ÙJNÂˆÙ]›İ][ÛŠ˜[YHOˆ	İ˜[YKš[J
_IÜ™\İË›[™İÈ	Ü™\İËš›Ú[ŠˆŠ_XˆˆŸH
NÂˆNÂˆÛÛœİÛÛ\]P[˜\œÈH

HOˆÂˆYˆ
\Ğ›ØÚÚ[™Ñ\œ›ÜœÊH™]\›ÂˆÙ]Ø]™Y
˜[ÙJNÂˆÙ]›İ][ÛŠYX\İ\™\Ë›X\
YX\İ\™HOˆ	ÛYX\İ\™K››İ\Ë›X\
ˆOˆ‹œ˜]ÊKš›Ú[ŠˆŠ_IÛYX\İ\™K˜™X]È˜\Ø\XÚ]HÈ	Ü™\İÑ›ÜŠ˜\Ø\XÚ]HHYX\İ\™K˜™X]ÊKš›Ú[ŠˆŠ_XˆˆŸXš[J
JKš›Ú[ŠˆŠJNÂˆNÂˆÛÛœİØ]™U^š[HH
™\]Y\İY˜[YHH]JHOˆÂˆÛÛœİØY™U]HH™\]Y\İY˜[YKš[J
Kœ™\XÙJÖÏˆ‹×Ê—JËÙË‹HŠKœ™\XÙJ×ÊËÙËˆŠH››İ[KXÛÛ\ÜÚ][ÛˆÂˆÛÛœİÚÜ™[™\ÈHÚÜ™Xœ˜\K™Yš[š][ÛœË›X\
Yš[š][ÛˆOˆÈÚÜ™ˆ	ÙYš[š][Û‹›˜[Y_HHÉÙYš[š][Û‹œ]Ú\Ëš›Ú[Š‹Š_WX
Kš›Ú[Š—ˆŠNÂˆÛÛœİÛÛ[ÈHÈ›İ[WˆÈ]Nˆ	Ü™\]Y\İY˜[YKš[J
H•[]YÛÛ\ÜÚ][ÛˆŸWˆÈ[YNˆ	İ[YTÚYÛ˜]\™_WˆÈÙ^Nˆ	ÚÙ^TÚYÛ˜]\™_WˆÈ[\Îˆ	Øœ_IØÚÜ™[™\ÈÈ‰ØÚÜ™[™\ßXˆˆŸW—‰Û›İ][Û‹š[J
_W˜ÂˆÛÛœİ›ØˆH™]È›ØŠØÛÛ[×KÈ\Nˆ^ÜZ[ØÚ\œÙ]]]‹NˆJNÂˆÛÛœİ\›HT“˜Ü™X]SØš™XİT“
›ØŠNÂˆÛÛœİ[šÈHØİ[Y[˜Ü™X]Q[[Y[
˜HŠNÂˆ[šËš™YˆH\›Âˆ[šË™İÛ›ØYH	ÜØY™U]_KÂˆ[šË˜ÛXÚÊ
NÂˆT“œ™]›ÚÙSØš™XİT“
\›
NÂˆÙ]]J™\]Y\İY˜[YKš[J
H•[]YÛÛ\ÜÚ][ÛˆŠNÂˆÙ]Ø]™P\ÓÜ[Š˜[ÙJNÂˆÙ]š[SY\ÜØYÙJØ]™Y	ÜØY™U]_K
NÂˆNÂˆÛÛœİÜ[•^š[HH\Ş[˜È
]™[ˆ™XXİÚ[™ÙQ]™[S[œ][[Y[ŠHOˆÂˆÛÛœİš[HH]™[\™Ù]™š[\ÏË–ÌNÂˆ]™[\™Ù]˜[YHHˆÂˆYˆ
Yš[JH™]\›ÂˆYˆ
š[KœÚ^™HˆM—Ì
HÈÙ]š[SY\ÜØYÙJ•]š[H\ÈÛÈ\™ÙKˆÚÛÜÙHHÚÜ[™š[H[™\ˆMˆĞ‹ˆŠNÈ™]\›ÈBˆÛÛœİ^H
]ØZ]š[K^

JKš[J
NÂˆYˆ
]^
HÈÙ]š[SY\ÜØYÙJ•]š[H\È[\KˆŠNÈ™]\›ÈBˆÛÛœİY]Y]HHØš™Xİ™œ›ÛQ[šY\ÊË‹‹^›X]Ú[
×ˆ×ÊŠ]_[Y_Ù^_[\ÊN—ÊŠŠÊIÙÚ[JWK›X\
X]ÚOˆÛX]ÚÌWKÓİÙ\Ø\ÙJ
KX]ÚÌ—Kš[J
WJJNÂˆÛÛœİ[\ÜYÚÜ™ÈHË‹‹^›X]Ú[
×ˆ×Ê˜ÚÜ™—ÊŠŠÊIÙÚ[JWK›X\
X]ÚOˆX]ÚÌWKš[J
JKš›Ú[Š—ˆŠNÂˆÛÛœİÚÜ[™H^œÜ]
××‹ÊK™š[\Š[™HOˆ[[™Kš[J
Kœİ\ÕÚ]
ˆÈŠJKš›Ú[ŠˆŠKš[J
NÂˆÛÛœİ[\ÜY[YHH[YTÚYÛ˜]\™\Ëš[˜ÛY\ÊY]Y]K[YJHÈY]Y]K[YHˆ[YTÚYÛ˜]\™NÂˆÛÛœİ[\ÜYXœ˜\HH\œÙPÚÜ™Yš[š][ÛœÊ[\ÜYÚÜ™ÊNÂˆYˆ
[\ÜYXœ˜\K™\œ›ÜœË›[™İ
HÈÙ]š[SY\ÜØYÙJÛİ[›İÜ[ˆ	Ú[\ÜYXœ˜\K™\œ›ÜœÖÌ_K˜
NÈ™]\›ÈBˆÛÛœİ[\ÜYH\œÙPÛÛ\ÜÚ][ÛŠÚÜ[™™X]Ô\˜\Š[\ÜY[YJK[\ÜYXœ˜\K˜ÚÜ™ÊNÂˆÛÛœİ˜YÚÙ[œÈH[\ÜY™›]X\
YX\İ\™HOˆYX\İ\™Kš[˜[Y
NÂˆYˆ
˜YÚÙ[œË›[™İ
HÈÙ]š[SY\ÜØYÙJÛİ[›İÜ[ˆ[œİ\ÜYÚÙ[ˆ8 '	Ø˜YÚÙ[œÖÌ_x 'K˜
NÈ™]\›ÈBˆİÜ

NÂˆÙ]›İ][ÛŠÚÜ[™
NÂˆÙ]]JY]Y]K]Hš[K›˜[YKœ™\XÙJ×	ÚKˆŠH’[\ÜYÛÛ\ÜÚ][ÛˆŠNÂˆÙ][YTÚYÛ˜]\™J[\ÜY[YJNÂˆÙ]ÚÜ™Yš[š][ÛœÊ[\ÜYÚÜ™ÊNÂˆYˆ
Ù^TÚYÛ˜]\™\Ëš[˜ÛY\ÊY]Y]KšÙ^JJHÙ]Ù^TÚYÛ˜]\™JY]Y]KšÙ^JNÂˆYˆ
Y]Y]K[\È	‰ˆ[X™\ŠY]Y]K[\ÊHH	‰ˆ[X™\ŠY]Y]K[\ÊHHŒŒ
HÙ]œJ[X™\ŠY]Y]K[\ÊJNÂˆÙ]Ø]™Y
˜[ÙJNÂˆÙ]š[SY\ÜØYÙJÜ[™Y	Ùš[K›˜[Y_X
NÂˆNÂˆ™]\›ˆ
ˆXZ[‚ˆXY\ˆÛ\ÜÓ˜[YOHÜ˜\ˆ‚ˆ]ˆÛ\ÜÓ˜[YOH˜œ˜[™Ü[ˆÛ\ÜÓ˜[YOH˜œ˜[™X\šÈ“ÜÜ[Ü[“›İ[OÜÜ[Ù]‚ˆ]ˆÛ\ÜÓ˜[YO^ØØ]™Y	ÜØ]™YÈˆˆˆœØ]š[™ÈŸXOÜ[ˆÏˆÜØ]™YÈ”Ø]™YÛˆ\È]šXÙHˆˆ”Ø]š[™ø )ˆŸOÙ]‚ˆ]ˆÛ\ÜÓ˜[YOH™š[PXİ[ÛœÈ‚ˆ]ÛˆÛÛXÚÏ^Üš[ÛÛ\ÜÚ][ÛŸH\šXK[X™[H”š[ÚY]]\ÚXÈÜˆØ]™H]\ÈHˆÜ[¸¥©ÜÜ[”š[ÈØØ]Û‚ˆ]ÛˆÛÛXÚÏ^Ê
HOˆÈÙ]Ø]™P\Ó˜[YJ]JNÈÙ]Ø]™P\ÓÜ[ŠYJNÈ_H\šXK[X™[H”Ø]™HÛÛ\ÜÚ][Ûˆ\ÈH^š[HÜ[¸¡¤ÏÜÜ[”Ø]™H\ÏØØ]Û‚ˆ]ÛˆÛÛXÚÏ^Ê
HOˆš[R[œ]˜İ\œ™[Ë˜ÛXÚÊ
_H\šXK[X™[H“Ü[ˆHÚÜ[™^š[HÜ[¸¡¤OÜÜ[“Ü[ˆØØ]Û‚ˆ]ÛˆÛ\ÜÓ˜[YOH˜ÛX\Xİ[ÛˆˆÛÛXÚÏ^Ê
HOˆÙ]ÛX\“Ü[ŠYJ_H\šXK[X™[HÛX\ˆHXİ]™HÛÛ™ÈÜ[°åÏÜÜ[ÛX\ØØ]Û‚ˆ[œ]™Y^Ùš[R[œ]H\OH™š[HˆXØÙ\H‹^ÜZ[ˆˆÛÚ[™ÙO^ÛÜ[•^š[_HÏ‚ˆÙ]‚ˆÚXY\‚‚ˆ˜]ˆÛ\ÜÓ˜[YOHœÛÛ™ÕXœÈˆ\šXK[X™[H“Ü[ˆÛÛ™ÜÈ‚ˆ]ÜÛÛ™ÜË›X\
ÛÛ™ÈOˆ]ÛˆÙ^O^ÜÛÛ™ËšYHÛ\ÜÓ˜[YO^ÜÛÛ™ËšYOOHXİ]™TÛÛ™ÒYÈ˜Xİ]™HˆˆˆŸHÛÛXÚÏ^Ê
HOˆİÚ]ÚÛÛ™ÊÛÛ™ËšY
_H\šXKXİ\œ™[^ÜÛÛ™ËšYOOHXİ]™TÛÛ™ÒYÈœYÙHˆˆ[™Yš[™YOÜÛÛ™ËšYOOHXİ]™TÛÛ™ÒYÈ
]Kš[J
H•[]YÛÛ\ÜÚ][ÛˆŠHˆ
ÛÛ™Ë]Kš[J
H•[]YÛÛ\ÜÚ][ÛˆŠ_OØ]ÛŠ_OÙ]‚ˆ]ÛˆÛ\ÜÓ˜[YOH›™]ÔÛÛ™ÈˆÛÛXÚÏ^ØYÛÛ™ßH\šXK[X™[HÜ™X]HH™]ÈÛÛ™ÈŠÈ™]ÈÛÛ™ÏØ]Û‚ˆÛ˜]‚‚ˆÙXİ[ÛˆÛ\ÜÓ˜[YOHÛÜšÜÜXÙH‚ˆ]ˆÛ\ÜÓ˜[YOH]T›İÈ‚ˆ]ˆÛ\ÜÓ˜[YOH]P›ØÚÈX™[[›ÜHœÛÛ™Ë]]HÛÛ\ÜÚ][Ûˆ˜[YOÛX™[[œ]YHœÛÛ™Ë]]HˆÛ\ÜÓ˜[YOHœÛÛ™Õ]Hˆ˜[YO^İ]_HÛÚ[™ÙO^Ù]™[OˆÈÙ]Ø]™Y
˜[ÙJNÈÙ]]J]™[\™Ù]˜[YJNÈ_H\šXK[X™[HÛÛ\ÜÚ][Ûˆ]HˆÏ”İ[™\™[š[™È0­ÈİZ]\ˆ0­ÈÚÙ^TÚYÛ˜]\™_HXZ›Üˆ0­Èİ[YTÚYÛ˜]\™_OÜÙ]‚ˆ]ÛˆÛ\ÜÓ˜[YOHš[ˆÛÛXÚÏ^Ê
HOˆÙ][
Z[
_H\šXKY^[™Y^Ú[OÏØ]Û‚ˆÙ]‚‚ˆÚ[	‰ˆ\ÚYHÛ\ÜÓ˜[YOHš[Ø\™”ÚÜ[™İZYOØ]ÛˆÛÛXÚÏ^Ê
HOˆÙ][
˜[ÙJ_H\šXK[X™[HÛÜÙHİZYH°åÏØ]ÛÛÙO‘ˆÍÎØÛÙOˆ\È[ˆZYÚ›İKˆ\ÙHÛÙOœ‹ÎØÛÙOˆ›ÜˆH™\İÛÙOÍÍØÛÙOˆ›ÜˆHİY›İK[™ÛÙOÍÍˆÍÍØÛÙOˆ›ÜˆYY›İ\ËˆYš[™HÛÙOSHHĞLËMMÈÍKMWOØÛÙOˆ[ˆHÚÜ™Xœ˜\K[ˆ[\ˆÛÙOSKÍØÛÙOˆ[]Ú\™H[ˆ[İ\ˆÚÜ[™ÜØ\ÚYOŸB‚ˆÙXİ[ÛˆÛ\ÜÓ˜[YOHœØÛÜ™TÙ][™ÜÈˆ\šXK[X™[H”ØÛÜ™HÙ][™ÜÈ‚ˆX™[•[YHÚYÛ˜]\™OÙ[Xİ˜[YO^İ[YTÚYÛ˜]\™_HÛÚ[™ÙO^Ù]™[OˆÈÙ]Ø]™Y
˜[ÙJNÈÙ][YTÚYÛ˜]\™J]™[\™Ù]˜[YJNÈ_Oİ[YTÚYÛ˜]\™\Ë›X\
˜[YHOˆÜ[ÛˆÙ^O^İ˜[Y_Oİ˜[Y_OÛÜ[ÛŠ_OÜÙ[XİÛX™[‚ˆX™[’Ù^HÚYÛ˜]\™OÙ[Xİ˜[YO^ÚÙ^TÚYÛ˜]\™_HÛÚ[™ÙO^Ù]™[OˆÈÙ]Ø]™Y
˜[ÙJNÈÙ]Ù^TÚYÛ˜]\™J]™[\™Ù]˜[YJNÈ_OÚÙ^TÚYÛ˜]\™\Ë›X\
˜[YHOˆÜ[ÛˆÙ^O^İ˜[Y_Oİ˜[Y_OÛÜ[ÛŠ_OÜÙ[XİÛX™[‚ˆÜÙXİ[Û‚‚ˆÙXİ[ÛˆÛ\ÜÓ˜[YOH˜ÚÜ™Xœ˜\Hˆ\šXK[X™[YOH˜ÚÜ™[Xœ˜\K]]H‚ˆ]X™[YH˜ÚÜ™[Xœ˜\K]]Hˆ[›ÜH˜ÚÜ™YYš[š][ÛœÈÚÜ™Yš[š][ÛœÏÛX™[Ü[“Û™H\ˆ[™OÜÜ[Ù]‚ˆ^\™XHYH˜ÚÜ™YYš[š][ÛœÈˆÛ\ÜÓ˜[YOH˜ÚÜ™Yš[š][ÛœÈˆ˜[YO^ØÚÜ™Yš[š][ÛœßHÛÚ[™ÙO^Ù]™[OˆÈÙ]Ø]™Y
˜[ÙJNÈÙ]ÚÜ™Yš[š][ÛœÊ]™[\™Ù]˜[YJNÈ_HÜ[ÚXÚÏ^Ù˜[Ù_HXÙZÛ\HSHHĞLËMMÈÍKMWHˆÏ‚ˆØÚÜ™Xœ˜\K™\œ›ÜœË›[™İˆ	‰ˆÛ\ÜÓ˜[YOH˜ÚÜ™\œ›Üˆˆ›ÛOH˜[\ØÚÜ™Xœ˜\K™\œ›ÜœÖÌ_OÜŸBˆØÚÜ™Xœ˜\K™Yš[š][ÛœË›[™İˆ	‰ˆ]ˆÛ\ÜÓ˜[YOH˜ÚÜ™ÚÜİ]Èˆ\šXK[X™[H‘Yš[™YÚÜ™ÚÜİ]ÈØÚÜ™Xœ˜\K™Yš[š][ÛœË›X\
Yš[š][ÛˆOˆ]ÛˆÙ^O^ÙYš[š][Û‹›˜[Y_HÛÛXÚÏ^Ê
HOˆ[œÙ\
	ÙYš[š][Û‹›˜[Y_KÍ
_H]O^Ø[œÙ\	ÙYš[š][Û‹›˜[Y_H\ÈH]X\\‹[›İHÚÜ™OÙYš[š][Û‹›˜[Y_KÍØ]ÛŠ_OÙ]ŸBˆÜÙXİ[Û‚‚ˆÙXİ[ÛˆÛ\ÜÓ˜[YOHœØÛÜ™PØ\™ˆ\šXK[X™[H”™[™\™YÚY]]\ÚXÈ‚ˆ]ˆÛ\ÜÓ˜[YOHœØÛÜ™TØÜ›Û‚ˆ[™Ü˜]™YØÛÜ™HYX\İ\™\Ï^ÛYX\İ\™\ßHXİ]™O^ØXİ]™_HœO^Øœ_H[YTÚYÛ˜]\™O^İ[YTÚYÛ˜]\™_HÙ^TÚYÛ˜]\™O^ÚÙ^TÚYÛ˜]\™_HÏ‚ˆÙ]‚ˆ]ˆÛ\ÜÓ˜[YOH›YX\İ\™Tİ]\ÈÜ[ÛYX\İ\™\Ë›[™İHÛYX\İ\™\Ë›[™İOOHHÈ›YX\İ\™Hˆˆ›YX\İ\™\ÈŸOÜÜ[Ü[İİ[™X]ßH™X]ÏÜÜ[Ü[ˆÛ\ÜÓ˜[YO^Ø[ÛÛ\]HÈ˜[YˆˆØ\›š[™ÈŸOØ[ÛÛ\]HÈ¸§$È]™\H˜\ˆ\È™X]Èˆˆ\Ğ›ØÚÚ[™Ñ\œ›ÜœÈÈˆHš^YÚYÚY˜\œÈˆˆ¸ (ˆÛÛ\]HHÜ[ˆ˜\œÈŸOÜÜ[Ù]‚ˆÜÙXİ[Û‚‚ˆÙXİ[ÛˆÛ\ÜÓ˜[YOH™Y]Üˆ‚ˆX™[[›ÜH››İ][ÛˆÜ[–[İ\ˆÚÜ[™ÜÜ[Ü[ˆÛ\ÜÓ˜[YOHœŞ[^”]Ú
ÈØİ]™HÈ\˜][ÛÜÜ[ÛX™[‚ˆÙš[SY\ÜØYÙH	‰ˆ]ˆÛ\ÜÓ˜[YOH™š[SY\ÜØYÙHˆ›ÛOHœİ]\ÈÜ[Ùš[SY\ÜØYÙ_OÜÜ[]ÛˆÛÛXÚÏ^Ê
HOˆÙ]š[SY\ÜØYÙJˆŠ_H\šXK[X™[H‘\ÛZ\ÜÈš[HY\ÜØYÙH°åÏØ]ÛÙ]ŸBˆ^\™XHYH››İ][Ûˆˆ˜[YO^Û›İ][ÛŸHÛÚ[™ÙO^Ù]™[OˆÚ[™ÙS›İ][ÛŠ]™[\™Ù]˜[YJ_HÜ[ÚXÚÏ^Ù˜[Ù_H\šXKY\ØÜšX™YOH˜˜\‹Y™YY˜XÚÈ‹Ï‚ˆ]ˆÛ\ÜÓ˜[YOHœ]ZXÚÒÙ^\È‚ˆÖÈÍÍ‹‘Í‹‘MÍ‹‘Í‹‘ÍÍ‹MÍ‹Í‹œ‹Í‹œ‹Íˆ—K›X\
˜[YHOˆ]ÛˆÛÛXÚÏ^Ê
HOˆ[œÙ\
˜[YJ_HÙ^O^İ˜[Y_Oİ˜[Y_OØ]ÛŠ_Bˆ]ÛˆÛ\ÜÓ˜[YOH™İ\İˆÛÛXÚÏ^Ùİ\İH\ØX›Y^ÈXØ[‘İ\İO°­Èİ\İØ]Û‚ˆ]ÛˆÛ\ÜÓ˜[YOHYS\İˆÛÛXÚÏ^İYS\İH\ØX›Y^ÈXØ[•YS\İO¸£$ˆYH\İØ]Û‚ˆ]ÛˆÛÛXÚÏ^Ê
HOˆ[œÙ\
–ĞÍMÍKÍŠ_OÈÚÜ™Ø]Û‚ˆ]ÛˆÛ\ÜÓ˜[YOH™š[š\Ú˜\ˆˆÛÛXÚÏ^ØÛÛ\]P˜\ŸH\ØX›Y^Ú\Ğ›ØÚÚ[™Ñ\œ›ÜœÈ]˜\›İ[™\_O‘š[š\Ú˜\‰›˜œÜÈØ]Û‚ˆÙ]‚ˆ]ˆÛ\ÜÓ˜[YOH˜˜\‘™YY˜XÚÈˆYH˜˜\‹Y™YY˜XÚÈˆ\šXK[]™OHœÛ]H‚ˆ]ˆÛ\ÜÓ˜[YOH˜˜\Ú\ÈÛYX\İ\™\Ë›X\

YX\İ\™K[™^
HOˆÜ[ˆÙ^O^Ú[™^HÛ\ÜÓ˜[YO^ÛYX\İ\™Kœİ]\ßOÛYX\İ\™Kœİ]\ÈOOH˜ÛÛ\]HˆÈ¸§$ÈˆˆYX\İ\™Kœİ]\ÈOOH[™\ˆˆÈ	Ø˜\Ø\XÚ]HHYX\İ\™K˜™X]ßH™X]	Ø˜\Ø\XÚ]HHYX\İ\™K˜™X]ÈOOHHÈˆˆˆœÈŸHZ\ÜÚ[™ØˆYX\İ\™Kœİ]\ÈOOH›İ™\ˆˆÈ	ÛYX\İ\™K˜™X]ÈH˜\Ø\XÚ]_H™X]	ÛYX\İ\™K˜™X]ÈH˜\Ø\XÚ]HOOHHÈˆˆˆœÈŸHİ™\˜ˆ[˜[Yˆ	ÛYX\İ\™Kš[˜[Yš›Ú[Š‹Š_XOÛX[˜\ˆÚ[™^
È_OÜÛX[ÜÜ[Š_OÙ]‚ˆÈX[ÛÛ\]H	‰ˆZ\Ğ›ØÚÚ[™Ñ\œ›ÜœÈ	‰ˆ]ÛˆÛÛXÚÏ^ØÛÛ\]P[˜\œßO‘š[Z\ÜÚ[™È™X]ÈÚ]™\İÏØ]ÛŸBˆÙ]‚ˆÜÙXİ[Û‚ˆÜÙXİ[Û‚‚ˆÙXİ[ÛˆÛ\ÜÓ˜[YOHœš[ÚY]ˆ\šXKZY[HYH‚ˆXY\]ˆÛ\ÜÓ˜[YOHœš[œ˜[™“›İ[OÙ]Oİ]Kš[J
H•[]YÛÛ\ÜÚ][ÛˆŸOÚO‘İZ]\ˆ0­Èİ[™\™[š[™È0­ÈÚÙ^TÚYÛ˜]\™_HXZ›Üˆ0­Èİ[YTÚYÛ˜]\™_H0­È8¦jHHØœ_OÜÚXY\‚ˆ]ˆÛ\ÜÓ˜[YOHœš[Ş\İ[\ÈÜš[Ş\İ[\Ë›X\

Ş\İ[K[™^
HOˆ]ˆÛ\ÜÓ˜[YOHœš[Ş\İ[HˆÙ^O^Ú[™^O[™Ü˜]™YØÛÜ™HYX\İ\™\Ï^ÜŞ\İ[_HXİ]™O^ËL_HœO^Øœ_H[YTÚYÛ˜]\™O^İ[YTÚYÛ˜]\™_HÙ^TÚYÛ˜]\™O^ÚÙ^TÚYÛ˜]\™_HÏÙ]Š_OÙ]‚ˆ›Ûİ\İ]Kš[J
H•[]YÛÛ\ÜÚ][ÛˆŸH0­Èš[Yœ›ÛH›İ[OÙ›Ûİ\‚ˆÜÙXİ[Û‚‚ˆÜØ]™P\ÓÜ[ˆ	‰ˆ]ˆÛ\ÜÓ˜[YOH›[Ù[˜XÚÙ›Üˆ›ÛOHœ™\Ù[][ÛˆˆÛ“[İ\ÙQİÛ^Ê
HOˆÙ]Ø]™P\ÓÜ[Š˜[ÙJ_O›Ü›HÛ\ÜÓ˜[YOHœØ]™QX[ÙÈˆÛ“[İ\ÙQİÛ^Ù]™[Oˆ]™[œİÜ›ÜYØ][ÛŠ
_HÛ”İX›Z]^Ù]™[OˆÈ]™[œ™]™[Y˜][

NÈØ]™U^š[JØ]™P\Ó˜[YJNÈ_O”Ø]™HÛÛ\ÜÚ][ÛÚX™[[›ÜHœØ]™K[˜[YH‘š[H[™ÛÛ\ÜÚ][Ûˆ˜[YOÛX™[[œ]YHœØ]™K[˜[YHˆ˜[YO^ÜØ]™P\Ó˜[Y_HÛÚ[™ÙO^Ù]™[OˆÙ]Ø]™P\Ó˜[YJ]™[\™Ù]˜[YJ_H]]Ñ›Øİ\ÈÏ–[İ\ˆÚÜ[™ÚÜ™Yš[š][ÛœË[\Ë[YHÚYÛ˜]\™K[™Ù^HÚYÛ˜]\™HÚ[™H[˜ÛYYÜ]]Ûˆ\OH˜]ÛˆˆÛÛXÚÏ^Ê
HOˆÙ]Ø]™P\ÓÜ[Š˜[ÙJ_OØ[˜Ù[Ø]Û]ÛˆÛ\ÜÓ˜[YOHœš[X\Hˆ\OHœİX›Z]”Ø]™HØ]ÛÙ]Ù›Ü›OÙ]ŸBˆØÛX\“Ü[ˆ	‰ˆ]ˆÛ\ÜÓ˜[YOH›[Ù[˜XÚÙ›Üˆ›ÛOHœ™\Ù[][ÛˆˆÛ“[İ\ÙQİÛ^Ê
HOˆÙ]ÛX\“Ü[Š˜[ÙJ_OÙXİ[ÛˆÛ\ÜÓ˜[YOHœØ]™QX[ÙÈÛÛ™š\›QX[ÙÈˆ›ÛOH˜[\X[ÙÈˆ\šXK[[Ù[HYHˆ\šXK[X™[YOH˜ÛX\‹]]HˆÛ“[İ\ÙQİÛ^Ù]™[Oˆ]™[œİÜ›ÜYØ][ÛŠ
_OˆYH˜ÛX\‹]]HÛX\ˆ\ÈÛÛ™ÏÏÚ•\ÈÚ[\˜\ÙHH›İ][Ûˆ[™ÚÜ™Yš[š][ÛœÈ[ˆİ]Kš[J
H\ÈÛÛ™ÈŸOØˆ[™™\Ù]]ÈÙ][™ÜËˆ[İ\ˆİ\ˆÛÛ™ÈXœÈÚ[›İ™HÚ[™ÙYÜ]]Ûˆ\OH˜]ÛˆˆÛÛXÚÏ^Ê
HOˆÙ]ÛX\“Ü[Š˜[ÙJ_OØ[˜Ù[Ø]Û]ÛˆÛ\ÜÓ˜[YOH™[™Ù\ˆˆ\OH˜]ÛˆˆÛÛXÚÏ^ØÛX\”ÛÛ™ßOÛX\ˆÛÛ™ÏØ]ÛÙ]ÜÙXİ[ÛÙ]ŸB‚ˆ›Ûİ\ˆÛ\ÜÓ˜[YOH˜[œÜÜ‚ˆ]ˆÛ\ÜÓ˜[YOH[\ÈX™[[›ÜH[\È•[\ÏÛX™[]ÛˆÛÛXÚÏ^Ê
HOˆÈÙ]Ø]™Y
˜[ÙJNÈÙ]œJX]›X^
œKLJJNÈ_H\šXK[X™[H‘XÜ™X\ÙH[\È¸¢$Ø]Û[œ]YH[\Èˆ\OH›[X™\ˆˆZ[HˆX^HŒŒŒˆ˜[YO^Øœ_HÛÚ[™ÙO^Ù]™[OˆÈÙ]Ø]™Y
˜[ÙJNÈÙ]œJX]›Z[ŠŒŒX]›X^
[X™\Š]™[\™Ù]˜[YJJJJNÈ_KÏ]ÛˆÛÛXÚÏ^Ê
HOˆÈÙ]Ø]™Y
˜[ÙJNÈÙ]œJX]›Z[ŠŒŒœJÌJJNÈ_H\šXK[X™[H’[˜Ü™X\ÙH[\ÈŠÏØ]ÛÜ[”OÜÜ[Ù]‚ˆ]ÛˆÛ\ÜÓ˜[YOHœ^HˆÛÛXÚÏ^Ü^_H\ØX›Y^È[›İ\Ë›[™İOÜ[Ü^Z[™ÈÈ¸¥¨ˆˆ¸¥­ˆŸOÜÜ[Ü^Z[™ÈÈ”İÜˆˆ”^Hœ›ÛHİ\ŸOØ]Û‚ˆ]ÛˆÛ\ÜÓ˜[YO^ØÛÜ	ÛÛÜÈœÙ[XİYˆˆˆŸXHÛÛXÚÏ^Ê
HOˆÙ]ÛÜ
˜[YHOˆ]˜[YJ_H\šXK[X™[^Ø	ÛÛÜÈ‘\ØX›Hˆˆ‘[˜X›HŸHÛÜ^X˜XÚØH\šXK\™\ÜÙY^ÛÛÜO¸¡®ÏØ]Û‚ˆÙ›Ûİ\‚ˆÛXZ[‚ˆ
NÂŸB