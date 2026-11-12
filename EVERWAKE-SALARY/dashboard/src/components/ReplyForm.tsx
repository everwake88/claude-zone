'use client';
import { replyDispute } from '@/app/actions';
import { ActionForm, Submit, FormStatus } from './Submit';

export function ReplyForm({ id, words }: { id: string; words: { reply: string; hint: string; send: string } }) {
  return (
    <ActionForm action={replyDispute} className="form" resetOnOk>{(state) => (<>
      <input type="hidden" name="id" value={id} />
      <div className="field">
        <label htmlFor="reply">{words.reply}</label>
        <textarea className="textarea" id="reply" name="text" required aria-describedby="reply-h" dir="auto" />
        <span className="hint" id="reply-h">{words.hint}</span>
      </div>
      <div className="form-foot">
        <Submit className="btn">{words.send}</Submit>
        <FormStatus state={state} />
      </div>
    </>)}</ActionForm>
  );
}
