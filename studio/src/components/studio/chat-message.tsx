'use client';

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';
import { Bot, User } from 'lucide-react';
import {
  AgentCreateCard,
  parseAgentCreateBlock,
  type AgentCreatePayload,
} from './agent-create-card';

export interface ChatMessageData {
  id: string;
  role: string;
  content: string;
  provider?: string;
  model?: string;
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      components={{
         
        p: (props: any) => <p className="mb-2 last:mb-0 leading-relaxed" {...props} />,
         
        code: (props: any) => {
          const { inline, className, children } = props;
          if (inline) {
            return (
              <code className="px-1.5 py-0.5 rounded bg-black/30 text-emerald-300 text-[0.85em] font-mono">
                {children}
              </code>
            );
          }
          return (
            <code className={`${className ?? ''} font-mono text-sm`} >
              {children}
            </code>
          );
        },
         
        pre: (props: any) => (
          <pre
            className="my-2 rounded-lg bg-black/40 border border-white/10 p-3 overflow-x-auto text-sm"
            {...props}
          />
        ),
         
        ul: (props: any) => <ul className="mb-2 ml-5 list-disc space-y-1" {...props} />,
         
        ol: (props: any) => <ol className="mb-2 ml-5 list-decimal space-y-1" {...props} />,
         
        a: (props: any) => {
          const href = typeof props.href === 'string' ? props.href : '';
          const isSafe = /^https?:\/\//i.test(href) && !/^javascript:/i.test(href);
          return (
            <a
              className="text-emerald-400 underline underline-offset-2"
              target="_blank"
              rel="noreferrer"
              href={isSafe ? href : '#'}
              {...props}
            />
          );
        },
         
        h1: (props: any) => <h1 className="text-lg font-bold mb-2" {...props} />,
         
        h2: (props: any) => <h2 className="text-base font-bold mb-2" {...props} />,
         
        h3: (props: any) => <h3 className="text-sm font-bold mb-1" {...props} />,
         
        blockquote: (props: any) => (
          <blockquote className="border-l-2 border-emerald-500/50 pl-3 text-zinc-400 my-2" {...props} />
        ),
         
        table: (props: any) => (
          <div className="overflow-x-auto my-2">
            <table className="text-sm border-collapse border border-white/10" {...props} />
          </div>
        ),
         
        th: (props: any) => (
          <th className="border border-white/10 px-2.5 py-1.5 bg-white/5 font-semibold" {...props} />
        ),
         
        td: (props: any) => <td className="border border-white/10 px-2.5 py-1.5" {...props} />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export const ChatMessage = memo(function ChatMessage({
  message,
  agentEmoji,
  streaming,
  onCreateAgent,
}: {
  message: ChatMessageData;
  agentEmoji?: string;
  streaming?: boolean;
  onCreateAgent?: (agent: AgentCreatePayload) => Promise<boolean>;
}) {
  const isUser = message.role === 'user';

  // Detect AI self-created agent blocks (only for assistant messages)
  let visibleContent = message.content;
  let agentPayload: AgentCreatePayload | null = null;
  if (!isUser && onCreateAgent) {
    const parsed = parseAgentCreateBlock(message.content);
    visibleContent = parsed.visibleContent;
    agentPayload = parsed.payload;
  }

  return (
    <div className={cn('flex gap-3 max-w-3xl mx-auto w-full', isUser && 'flex-row-reverse')}>
      <div
        className={cn(
          'h-8 w-8 rounded-lg shrink-0 flex items-center justify-center mt-0.5',
          isUser
            ? 'bg-zinc-700 text-zinc-200'
            : 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30'
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <span className="text-base">{agentEmoji ?? '🤖'}</span>}
      </div>
      <div className={cn('min-w-0', isUser ? 'max-w-[80%]' : 'flex-1')}>
        <div
          className={cn(
            'rounded-2xl px-4 py-2.5 text-sm',
            isUser
              ? 'bg-emerald-600 text-white rounded-tr-md inline-block max-w-full'
              : 'bg-zinc-800/80 text-zinc-100 rounded-tl-md border border-zinc-700/50'
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          ) : (
            <>
              <MarkdownContent content={visibleContent || '…'} />
              {streaming && (
                <span className="inline-block h-4 w-2 bg-emerald-400 animate-pulse rounded-sm ml-0.5 align-text-bottom" />
              )}
            </>
          )}
        </div>
        {agentPayload && onCreateAgent && (
          <AgentCreateCard payload={agentPayload} onCreate={onCreateAgent} />
        )}
        {!isUser && message.model && (
          <p className="text-[10px] text-zinc-600 mt-1 px-1">
            {message.provider} · {message.model}
          </p>
        )}
      </div>
    </div>
  );
});

export function TypingIndicator({ agentEmoji }: { agentEmoji?: string }) {
  return (
    <div className="flex gap-3 max-w-3xl mx-auto w-full">
      <div className="h-8 w-8 rounded-lg shrink-0 flex items-center justify-center mt-0.5 bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
        <span className="text-base">{agentEmoji ?? <Bot className="h-4 w-4" />}</span>
      </div>
      <div className="rounded-2xl rounded-tl-md bg-zinc-800/80 border border-zinc-700/50 px-4 py-3">
        <div className="flex gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-bounce [animation-delay:0ms]" />
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-bounce [animation-delay:150ms]" />
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}
