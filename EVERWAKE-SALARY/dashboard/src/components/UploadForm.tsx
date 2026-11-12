'use client';
import { useState } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import { uploadSheet } from '@/app/actions';
import { ActionForm, Submit, FormStatus } from './Submit';

type Words = { file: string; fileHint: string; period: string; title: string; titleHint: string; read: string; reading: string; replaceWarn: string };

export function UploadForm({ words, defaultMonth, published }: { words: Words; defaultMonth: string; published: Record<string, string> }) {
  const [file, setFile] = useState<string>('');
  const [over, setOver] = useState(false);
  const [month, setMonth] = useState(defaultMonth);
  return (
    <ActionForm action={uploadSheet} className="form">{(state) => (<>
      <div className="field">
        <span className="label" id="file-l">{words.file}</span>
        <label className={`drop${over ? ' over' : ''}`} onDragOver={() => setOver(true)} onDragLeave={() => setOver(false)} onDrop={() => setOver(false)}>
          <input type="file" name="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                 aria-labelledby="file-l" aria-describedby="file-h" required onChange={(e) => setFile(e.target.files?.[0]?.name || '')} />
          <FileSpreadsheet aria-hidden="true" />
          <span className="file ltr">{file || '.xlsx · .csv'}</span>
          <span className="hint" id="file-h">{words.fileHint}</span>
        </label>
      </div>
      <div className="field">
        <label htmlFor="period">{words.period}</label>
        <input className="input ltr" type="month" id="period" name="period" required value={month} onChange={(e) => setMonth(e.target.value)} />
        {published[month] && <p className="notice">{words.replaceWarn.replace('{month}', published[month])}</p>}
      </div>
      <div className="field">
        <label htmlFor="title">{words.title}</label>
        <input className="input" id="title" name="title" aria-describedby="title-h" />
        <span className="hint" id="title-h">{words.titleHint}</span>
      </div>
      <div className="form-foot">
        <Submit pending={words.reading}>{words.read}</Submit>
        <FormStatus state={state} />
      </div>
    </>)}</ActionForm>
  );
}
