'use client';

// persona-panel.tsx — choose WHO is talking: JARVIS, F.R.I.D.A.Y, a friend, a
// mentor or the neutral Studio voice. The animated avatar previews the choice
// in every state (idle / listening / thinking / speaking) and the settings are
// stored server-side, so Chat and voice use the same character.

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { RefreshCw, Save, Volume2, Sparkles } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { JarvisAvatar, type AvatarGender, type AvatarState } from '@/components/jarvis/jarvis-avatar';

interface Persona {
  id: string;
  name: string;
  tagline: string;
  emoji: string;
  gender: AvatarGender;
  hue: number;
  greeting: string;
  directive: string;
}

interface PersonaSettings {
  personaId: string;
  userTitle: string;
  humor: number;
  verbosity: number;
  language: 'auto' | 'hi' | 'en' | 'hinglish';
}

const STATES: AvatarState[] = ['idle', 'listening', 'thinking', 'speaking'];

const LANGUAGES: { id: PersonaSettings['language']; label: string }[] = [
  { id: 'auto', label: 'Auto (user ki language)' },
  { id: 'hi', label: 'Hindi' },
  { id: 'en', label: 'English' },
  { id: 'hinglish', label: 'Hinglish' },
];

export function PersonaPanel() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [settings, setSettings] = useState<PersonaSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<AvatarState>('idle');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/persona');
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to load personas');
      const data = await res.json();
      setPersonas(data.personas ?? []);
      setSettings(data.settings ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load personas');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // the avatar previews every state on its own, so the user can see what the
  // character will look like while it listens / thinks / talks
  useEffect(() => {
    let i = 0;
    const timer = setInterval(() => {
      i = (i + 1) % STATES.length;
      setPreviewState(STATES[i]);
    }, 2600);
    return () => clearInterval(timer);
  }, []);

  const save = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await fetch('/api/persona', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setSettings(data.settings);
      toast({ title: 'Character saved', description: `${data.persona?.name ?? 'Character'} is now active in Chat and voice.` });
    } catch (err) {
      toast({
        title: 'Could not save',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const active = personas.find((p) => p.id === settings?.personaId) ?? personas[0];

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400">
        <RefreshCw className="h-4 w-4 animate-spin mr-2" /> Loading characters…
      </div>
    );
  }

  if (error || !settings) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-400">
        <p className="text-sm">{error ?? 'Character settings unavailable'}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="h-4 w-4 mr-2" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-cyan-400" /> Character
            </h2>
            <p className="text-sm text-zinc-400 mt-1">
              Kaun baat kar raha hai — JARVIS, dost, mentor ya neutral assistant. Yahi character Chat,
              voice aur dashboard me use hota hai.
            </p>
          </div>
          <Button onClick={() => void save()} disabled={saving} className="bg-cyan-600 hover:bg-cyan-500 text-white">
            <Save className="h-4 w-4 mr-2" /> {saving ? 'Saving…' : 'Save'}
          </Button>
        </header>

        {/* live preview */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 flex flex-col sm:flex-row items-center gap-6">
          <JarvisAvatar
            gender={(active?.gender ?? 'male') as AvatarGender}
            hue={active?.hue ?? 190}
            state={previewState}
            size={148}
            label={active?.name}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-lg font-semibold">{active?.name}</span>
              <Badge variant="outline" className="border-cyan-500/40 text-cyan-300 capitalize">
                {active?.gender}
              </Badge>
              <Badge variant="outline" className="border-zinc-600 text-zinc-300">
                state: {previewState}
              </Badge>
            </div>
            <p className="text-sm text-zinc-400 mt-1">{active?.tagline}</p>
            <p className="text-sm text-zinc-300 mt-3 italic">&ldquo;{active?.greeting}&rdquo;</p>
            <p className="text-[11px] text-zinc-500 mt-3 flex items-center gap-1.5">
              <Volume2 className="h-3.5 w-3.5" />
              Voice: {active?.gender === 'female' ? 'female voice' : active?.gender === 'male' ? 'male voice' : 'neutral voice'}
            </p>
          </div>
        </section>

        {/* persona cards */}
        <section>
          <h3 className="text-sm font-semibold text-zinc-200 mb-3">Choose a character</h3>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {personas.map((persona) => {
              const selected = settings.personaId === persona.id;
              return (
                <button
                  key={persona.id}
                  onClick={() => setSettings({ ...settings, personaId: persona.id })}
                  className={`text-left rounded-xl border p-4 transition-colors ${
                    selected
                      ? 'border-cyan-400/60 bg-cyan-500/10'
                      : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700'
                  }`}
                  aria-pressed={selected}
                >
                  <div className="flex items-center gap-3">
                    <JarvisAvatar gender={persona.gender} hue={persona.hue} state={selected ? 'speaking' : 'idle'} size={52} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate">{persona.name}</span>
                        <span aria-hidden>{persona.emoji}</span>
                      </div>
                      <p className="text-[11px] text-zinc-400 line-clamp-2">{persona.tagline}</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* behaviour */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-5">
          <h3 className="text-sm font-semibold text-zinc-200">Behaviour</h3>

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="persona-title" className="text-xs text-zinc-400">
                Character aapko kya bulaye (optional)
              </Label>
              <Input
                id="persona-title"
                value={settings.userTitle}
                maxLength={40}
                placeholder="Sir, Boss, Ankit…"
                onChange={(e) => setSettings({ ...settings, userTitle: e.target.value })}
                className="mt-1.5 bg-zinc-950 border-zinc-800"
              />
            </div>
            <div>
              <Label className="text-xs text-zinc-400">Language</Label>
              <select
                value={settings.language}
                onChange={(e) =>
                  setSettings({ ...settings, language: e.target.value as PersonaSettings['language'] })
                }
                className="mt-1.5 w-full h-9 rounded-md bg-zinc-950 border border-zinc-800 px-2 text-sm"
                aria-label="Reply language"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>Humour</span>
              <span className="font-mono">{settings.humor}</span>
            </div>
            <Slider
              value={[settings.humor]}
              min={0}
              max={100}
              step={5}
              onValueChange={([v]) => setSettings({ ...settings, humor: v })}
              className="mt-2"
            />
          </div>

          <div>
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>Reply length</span>
              <span className="font-mono">{settings.verbosity}</span>
            </div>
            <Slider
              value={[settings.verbosity]}
              min={0}
              max={100}
              step={5}
              onValueChange={([v]) => setSettings({ ...settings, verbosity: v })}
              className="mt-2"
            />
          </div>

          <p className="text-[11px] text-zinc-500">
            Ye settings server par save hoti hain aur <code>system prompt</code> me jati hain — safety rules
            (approval, kill switch) par koi asar nahi padta.
          </p>
        </section>
      </div>
    </div>
  );
}
