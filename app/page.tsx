
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
        while (notes[chain]?.tied && notes[chain + 1]?.midis.join(",") === note.midis.join(",")) {
          tiedLength += notes[chain + 1].beats * secondPerBeat;
          chain++;
        }
        note.midis.forEach(midi => tone(ctx, midi, ctx.currentTime + cursor + .04, tiedLength * .96));
      }
      timers.current.push(window.setTimeout(() => setActive(index), cursor * 1000));
      cursor += length;
    });
    timers.current.push(window.setTimeout(() => {
      timers.current = [];
      void ctx.close();
      if (loopRef.current) schedulePlayback(); else { audio.current = null; setPlaying(false); setActive(-1); }
    }, cursor * 1000 + 100));
  };

  const play = () => { if (playing) stop(); else schedulePlayback(); };
  const currentSong = (): Song => ({ id: activeSongId, notation, title, bpm, timeSignature, keySignature, chordDefinitions });
  const loadSong = (song: Song) => {
    stop(); setActiveSongId(song.id); setNotation(song.notation); setTitle(song.title); setBpm(song.bpm); setTimeSignature(song.timeSignature); setKeySignature(song.keySignature); setChordDefinitions(song.chordDefinitions); setFileMessage(""); setSaved(true);
  };
  const switchSong = (id: string) => {
    if (id === activeSongId) return;
    const target = songs.find(song => song.id === id);
    if (!target) return;
    setSongs(current => current.map(song => song.id === activeSongId ? currentSong() : song));
    loadSong(target);
  };
  const addSong = () => {
    const song = newSong();
    setSongs(current => [...current.map(item => item.id === activeSongId ? currentSong() : item), song]);
    loadSong(song);
  };
  const clearSong = () => {
    stop(); setNotation(""); setTitle("Untitled composition"); setBpm(92); setTimeSignature("4/4"); setKeySignature("C"); setChordDefinitions(""); setFileMessage(""); setClearOpen(false); setSaved(false);
  };
  const printComposition = () => {
    stop();
    window.print();
  };
  const changeNotation = (value: string) => { setSaved(false); setNotation(value); };
  const insert = (value: string) => { setSaved(false); setNotation(current => `${current.trim()} ${value}`.trim()); };
  const dotLast = () => {
    if (!canDotLast) return;
    setSaved(false);
    setNotation(current => current.replace(/(\/(?:1|2|4|8|16))(?=\s*$)/, "$1."));
  };
  const tieLast = () => {
    if (!canTieLast) return;
    setSaved(false);
    setNotation(current => `${current.trim()}~`);
  };
  const completeBar = () => {
    if (atBarBoundary) return;
    const current = measures.at(-1)!;
    if (current.status === "over" || current.status === "invalid") return;
    const rests = restsFor(barCapacity - current.beats);
    setSaved(false);
    setNotation(value => `${value.trim()}${rests.length ? ` ${rests.join(" ")}` : ""} | `);
  };
  const completeAllBars = () => {
    if (hasBlockingErrors) return;
    setSaved(false);
    setNotation(measures.map(measure => `${measure.notes.map(n => n.raw).join(" ")}${measure.beats < barCapacity ? ` ${restsFor(barCapacity - measure.beats).join(" ")}` : ""}`.trim()).join(" | "));
  };
  const saveTextFile = (requestedName = title) => {
    const safeTitle = requestedName.trim().replace(/[<>:"/\\|?*]+/g, "-").replace(/\s+/g, " ") || "notely-composition";
    const chordLines = chordLibrary.definitions.map(definition => `# chord: ${definition.name} = [${definition.pitches.join(",")}]`).join("\n");
    const contents = `# Notely\n# title: ${requestedName.trim() || "Untitled composition"}\n# time: ${timeSignature}\n# key: ${keySignature}\n# tempo: ${bpm}${chordLines ? `\n${chordLines}` : ""}\n\n${notation.trim()}\n`;
    const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeTitle}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    setTitle(requestedName.trim() || "Untitled composition");
    setSaveAsOpen(false);
    setFileMessage(`Saved ${safeTitle}.txt`);
  };
  const openTextFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 256_000) { setFileMessage("That file is too large. Choose a shorthand file under 256 KB."); return; }
    const text = (await file.text()).trim();
    if (!text) { setFileMessage("That file is empty."); return; }
    const metadata = Object.fromEntries([...text.matchAll(/^#\s*(title|time|key|tempo):\s*(.+)$/gim)].map(match => [match[1].toLowerCase(), match[2].trim()]));
    const importedChords = [...text.matchAll(/^#\s*chord:\s*(.+)$/gim)].map(match => match[1].trim()).join("\n");
    const shorthand = text.split(/\r?\n/).filter(line => !line.trim().startsWith("#")).join(" ").trim();
    const importedTime = timeSignatures.includes(metadata.time) ? metadata.time : timeSignature;
    const importedLibrary = parseChordDefinitions(importedChords);
    if (importedLibrary.errors.length) { setFileMessage(`Could not open: ${importedLibrary.errors[0]}.`); return; }
    const imported = parseComposition(shorthand, beatsPerBar(importedTime), importedLibrary.chords);
    const badTokens = imported.flatMap(measure => measure.invalid);
    if (badTokens.length) { setFileMessage(`Could not open: unsupported token "${badTokens[0]}".`); return; }
    stop();
    setNotation(shorthand);
    setTitle(metadata.title || file.name.replace(/\.txt$/i, "") || "Imported composition");
    setTimeSignature(importedTime);
    setChordDefinitions(importedChords);
    if (keySignatures.includes(metadata.key)) setKeySignature(metadata.key);
    if (metadata.tempo && Number(metadata.tempo) >= 40 && Number(metadata.tempo) <= 220) setBpm(Number(metadata.tempo));
    setSaved(false);
    setFileMessage(`Opened ${file.name}`);
  };
  return (
    <main>
      <header className="topbar">
        <div className="brand"><span className="brandmark">N</span><span>Notely</span></div>
      <div className={`saved ${saved ? "" : "saving"}`}><span /> {saved ? "Saved on this device" : "Saving..."}</div>
        <div className="fileActions">
          <button onClick={printComposition} aria-label="Print sheet music or save it as a PDF"><span>[P]</span><b>Print / PDF</b></button>
          <button onClick={() => { setSaveAsName(title); setSaveAsOpen(true); }} aria-label="Save composition as a text file"><span>[S]</span><b>Save as</b></button>
          <button onClick={() => fileInput.current?.click()} aria-label="Open a shorthand text file"><span>[O]</span><b>Open .txt</b></button>
          <button className="clearAction" onClick={() => setClearOpen(true)} aria-label="Clear the active song"><span>X</span><b>Clear</b></button>
          <input ref={fileInput} type="file" accept=".txt,text/plain" onChange={openTextFile} />
        </div>
      </header>

      <nav className="songTabs" aria-label="Open songs">
        <div>{songs.map(song => <button key={song.id} className={song.id === activeSongId ? "active" : ""} onClick={() => switchSong(song.id)} aria-current={song.id === activeSongId ? "page" : undefined}>{song.id === activeSongId ? (title.trim() || "Untitled composition") : (song.title.trim() || "Untitled composition")}</button>)}</div>
        <button className="newSong" onClick={addSong} aria-label="Create a new song">+ New song</button>
      </nav>

      <section className="workspace">
        <div className="titleRow">
            <div className="titleBlock"><label htmlFor="song-title">Composition name</label><input id="song-title" className="songTitle" value={title} onChange={event => { setSaved(false); setTitle(event.target.value); }} aria-label="Composition title" /><p>Standard tuning / Guitar / {keySignature} major / {timeSignature}</p></div>
          <button className="help" onClick={() => setHelp(!help)} aria-expanded={help}>?</button>
        </div>

          {help && <aside className="helpCard"><b>Shorthand guide</b><button onClick={() => setHelp(false)} aria-label="Close guide">X</button><p><code>F#4/8</code> is an eighth note. Use <code>r/8</code> for a rest, <code>C4/4.</code> for a dotted note, and <code>C4/4~ C4/4</code> for tied notes. Define <code>AM = [A3,E4,A4,C#5,E5]</code> in the chord library, then enter <code>AM/4</code> anywhere in your shorthand.</p></aside>}

        <section className="scoreSettings" aria-label="Score settings">
          <label>Time signature<select value={timeSignature} onChange={event => { setSaved(false); setTimeSignature(event.target.value); }}>{timeSignatures.map(value => <option key={value}>{value}</option>)}</select></label>
          <label>Key signature<select value={keySignature} onChange={event => { setSaved(false); setKeySignature(event.target.value); }}>{keySignatures.map(value => <option key={value}>{value}</option>)}</select></label>
        </section>

        <section className="chordLibrary" aria-labelledby="chord-library-title">
          <div><label id="chord-library-title" htmlFor="chord-definitions">Chord definitions</label><span>One per line</span></div>
          <textarea id="chord-definitions" className="chordDefinitions" value={chordDefinitions} onChange={event => { setSaved(false); setChordDefinitions(event.target.value); }} spellCheck={false} placeholder="AM = [A3,E4,A4,C#5,E5]" />
          {chordLibrary.errors.length > 0 && <p className="chordError" role="alert">{chordLibrary.errors[0]}</p>}
          {chordLibrary.definitions.length > 0 && <div className="chordShortcuts" aria-label="Defined chord shortcuts">{chordLibrary.definitions.map(definition => <button key={definition.name} onClick={() => insert(`${definition.name}/4`)} title={`Insert ${definition.name} as a quarter-note chord`}>{definition.name}/4</button>)}</div>}
        </section>

        <section className="scoreCard" aria-label="Rendered sheet music">
          <div className="scoreScroll">
            <EngravedScore measures={measures} active={active} bpm={bpm} timeSignature={timeSignature} keySignature={keySignature} />
          </div>
            <div className="measureStatus"><span>{measures.length} {measures.length === 1 ? "measure" : "measures"}</span><span>{totalBeats} beats</span><span className={allComplete ? "valid" : "warning"}>{allComplete ? "OK Every bar has 4 beats" : hasBlockingErrors ? "! Fix highlighted bars" : "- Complete the open bars"}</span></div>
        </section>

        <section className="editor">
          <label htmlFor="notation"><span>Your shorthand</span><span className="syntax">Pitch + octave / duration</span></label>
            {fileMessage && <div className="fileMessage" role="status"><span>{fileMessage}</span><button onClick={() => setFileMessage("")} aria-label="Dismiss file message">X</button></div>}
          <textarea id="notation" value={notation} onChange={event => changeNotation(event.target.value)} spellCheck={false} aria-describedby="bar-feedback"/>
          <div className="quickKeys">
            {["C4/4","D4/4","E4/4","F4/4","G4/4","A4/4","B4/4","r/4","r/4."].map(value => <button onClick={() => insert(value)} key={value}>{value}</button>)}
              <button className="dotLast" onClick={dotLast} disabled={!canDotLast}>. Dot last</button>
              <button className="tieLast" onClick={tieLast} disabled={!canTieLast}>~ Tie last</button>
            <button onClick={() => insert("[C4,E4,G4]/4")}>C chord</button>
            <button className="finishBar" onClick={completeBar} disabled={hasBlockingErrors || atBarBoundary}>Finish bar&nbsp; |</button>
          </div>
          <div className="barFeedback" id="bar-feedback" aria-live="polite">
              <div className="barChips">{measures.map((measure, index) => <span key={index} className={measure.status}>{measure.status === "complete" ? "OK" : measure.status === "under" ? `${barCapacity - measure.beats} beat${barCapacity - measure.beats === 1 ? "" : "s"} missing` : measure.status === "over" ? `${measure.beats - barCapacity} beat${measure.beats - barCapacity === 1 ? "" : "s"} over` : `Invalid: ${measure.invalid.join(", ")}`}<small>Bar {index + 1}</small></span>)}</div>
            {!allComplete && !hasBlockingErrors && <button onClick={completeAllBars}>Fill missing beats with rests</button>}
          </div>
        </section>
      </section>

      <section className="printSheet" aria-hidden="true">
          <header><div className="printBrand">Notely</div><h1>{title.trim() || "Untitled composition"}</h1><p>Guitar / Standard tuning / {keySignature} major / {timeSignature} / quarter note = {bpm}</p></header>
        <div className="printSystems">{printSystems.map((system, index) => <div className="printSystem" key={index}><EngravedScore measures={system} active={-1} bpm={bpm} timeSignature={timeSignature} keySignature={keySignature} /></div>)}</div>
          <footer>{title.trim() || "Untitled composition"} / Printed from Notely</footer>
      </section>

      {saveAsOpen && <div className="modalBackdrop" role="presentation" onMouseDown={() => setSaveAsOpen(false)}><form className="saveDialog" onMouseDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); saveTextFile(saveAsName); }}><h2>Save composition</h2><label htmlFor="save-name">File and composition name</label><input id="save-name" value={saveAsName} onChange={event => setSaveAsName(event.target.value)} autoFocus /><p>Your shorthand, chord definitions, tempo, time signature, and key signature will be included.</p><div><button type="button" onClick={() => setSaveAsOpen(false)}>Cancel</button><button className="primary" type="submit">Save .txt</button></div></form></div>}
      {clearOpen && <div className="modalBackdrop" role="presentation" onMouseDown={() => setClearOpen(false)}><section className="saveDialog confirmDialog" role="alertdialog" aria-modal="true" aria-labelledby="clear-title" onMouseDown={event => event.stopPropagation()}><h2 id="clear-title">Clear this song?</h2><p>This will erase the notation and chord definitions in <b>{title.trim() || "this song"}</b> and reset its settings. Your other song tabs will not be changed.</p><div><button type="button" onClick={() => setClearOpen(false)}>Cancel</button><button className="danger" type="button" onClick={clearSong}>Clear song</button></div></section></div>}

      <footer className="transport">
          <div className="tempo"><label htmlFor="tempo">Tempo</label><button onClick={() => { setSaved(false); setBpm(Math.max(40,bpm-1)); }} aria-label="Decrease tempo">-</button><input id="tempo" type="number" min="40" max="220" value={bpm} onChange={event => { setSaved(false); setBpm(Math.min(220, Math.max(40, Number(event.target.value)))); }}/><button onClick={() => { setSaved(false); setBpm(Math.min(220,bpm+1)); }} aria-label="Increase tempo">+</button><span>BPM</span></div>
          <button className="play" onClick={play} disabled={!notes.length}><span>{playing ? "STOP" : "PLAY"}</span>{playing ? "Stop" : "Play from start"}</button>
          <button className={`loop ${loop ? "selected" : ""}`} onClick={() => setLoop(value => !value)} aria-label={`${loop ? "Disable" : "Enable"} loop playback`} aria-pressed={loop}>Loop</button>
      </footer>
    </main>
  );
}

