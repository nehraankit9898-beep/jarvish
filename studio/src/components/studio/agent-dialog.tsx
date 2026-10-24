'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Bot, Save } from 'lucide-react';
import { PROVIDERS, resolveModel, type ProviderId } from '@/lib/providers';

export interface AgentData {
  id?: string;
  name: string;
  emoji: string;
  systemPrompt: string;
  provider: string;
  model: string;
  temperature: number;
}

interface AgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: AgentData | null;
  onSave: (agent: AgentData) => Promise<void>;
}

const EMOJIS = ['🤖', '🧠', '🚀', '🎯', '💡', '📚', '🧑‍💻', '📝', '🎨', '🧪', '🔮', '🦉'];

const PRESETS = [
  {
    label: 'General Assistant',
    prompt:
      'You are a helpful AI assistant inside AgentScope Studio. Be concise, friendly and useful. Answer in the same language the user writes in.',
  },
  {
    label: 'Coding Expert',
    prompt:
      'You are an expert software engineer. Give correct, production-quality code with brief explanations. Prefer modern best practices. When unsure, state assumptions clearly.',
  },
  {
    label: 'Hindi Tutor',
    prompt:
      'Tum ek dost jaisa Hindi teacher ho. Har jawab simple Hinglish (Roman Hindi) me do, examples ke saath. Complex topics ko easy language me samjhao.',
  },
  {
    label: 'Storyteller',
    prompt:
      'You are a creative storyteller. Write vivid, engaging short stories with strong openings. Match the tone the user requests (funny, dark, romantic, sci-fi).',
  },
];

export function AgentDialog({ open, onOpenChange, initial, onSave }: AgentDialogProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [emoji, setEmoji] = useState(initial?.emoji ?? '🤖');
  const [systemPrompt, setSystemPrompt] = useState(
    initial?.systemPrompt ?? PRESETS[0].prompt
  );
  const [provider, setProvider] = useState<ProviderId>(
    (initial?.provider as ProviderId) ?? 'zai'
  );
  const [model, setModel] = useState(initial?.model ?? '');
  const [temperature, setTemperature] = useState(initial?.temperature ?? 0.7);
  const [saving, setSaving] = useState(false);

  // Reset form state whenever the dialog opens with a different agent
  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setEmoji(initial?.emoji ?? '🤖');
    setSystemPrompt(initial?.systemPrompt ?? PRESETS[0].prompt);
    setProvider((initial?.provider as ProviderId) ?? 'zai');
    setModel(initial?.model ?? '');
    setTemperature(initial?.temperature ?? 0.7);
  }, [open, initial]);

  const providerInfo = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];

  const handleProviderChange = (id: string) => {
    setProvider(id as ProviderId);
    const p = PROVIDERS.find((x) => x.id === id)!;
    setModel(p.defaultModel);
  };

  // Retired model (e.g. gemini-2.0-flash) saved agent me ho to current
  // model par map karke save/display karo — Select me invalid value na aaye
  const effectiveModel = resolveModel(providerInfo, model);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({
        id: initial?.id,
        name: name.trim(),
        emoji,
        systemPrompt,
        provider,
        model: effectiveModel,
        temperature,
      });
      onOpenChange(false);
    } catch (err) {
      // surface failure to caller via console; keep dialog open
      console.error('Failed to save agent', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg bg-zinc-900 border-zinc-800 text-zinc-100 max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-emerald-400" />
            {initial?.id ? 'Edit Agent' : 'Create Agent'}
          </DialogTitle>
          <DialogDescription>
            Apna custom AI agent banao — personality, model aur creativity sab aapke haath me.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Avatar</Label>
            <div className="flex flex-wrap gap-1.5">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEmoji(e)}
                  className={`h-9 w-9 rounded-lg text-lg flex items-center justify-center transition-colors ${
                    emoji === e
                      ? 'bg-emerald-500/20 ring-1 ring-emerald-400'
                      : 'bg-zinc-800 hover:bg-zinc-700'
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="agent-name">Agent name</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. CodeGuru"
              className="bg-zinc-800 border-zinc-700"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Engine (Provider)</Label>
              <Select value={provider} onValueChange={handleProviderChange}>
                <SelectTrigger className="bg-zinc-800 border-zinc-700">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-zinc-900 border-zinc-700">
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.emoji} {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Model</Label>
              {providerInfo.models.length > 0 ? (
                <Select value={effectiveModel} onValueChange={setModel}>
                  <SelectTrigger className="bg-zinc-800 border-zinc-700">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-zinc-900 border-zinc-700">
                    {providerInfo.models.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="model-name"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Quick presets</Label>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setSystemPrompt(p.prompt)}
                  className="text-xs px-2.5 py-1.5 rounded-full bg-zinc-800 hover:bg-emerald-500/20 hover:text-emerald-300 text-zinc-300 transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="agent-prompt">System Prompt (personality)</Label>
            <Textarea
              id="agent-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={5}
              className="bg-zinc-800 border-zinc-700 text-sm"
            />
          </div>

          <div className="space-y-2">
            <div className="flex justify-between">
              <Label>Creativity (temperature)</Label>
              <span className="text-sm text-emerald-400 font-mono">
                {temperature.toFixed(1)}
              </span>
            </div>
            <Slider
              value={[temperature]}
              onValueChange={(vals) => {
                if (vals && vals.length) setTemperature(vals[0]);
              }}
              min={0}
              max={2}
              step={0.1}
              className="py-2"
            />
            <div className="flex justify-between text-[11px] text-zinc-500">
              <span>Precise (0)</span>
              <span>Balanced (0.7)</span>
              <span>Wild (2)</span>
            </div>
          </div>

          <Button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white"
          >
            <Save className="h-4 w-4 mr-2" />
            {saving ? 'Saving…' : initial?.id ? 'Update Agent' : 'Create Agent'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
