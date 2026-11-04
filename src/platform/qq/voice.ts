import fs from 'node:fs';
import { ffmpegToPCM, loadSilkWasm, pcmToSilk } from '@tencent-connect/qqbot-nodejs/protocol';

/** QQ voice messages use SILK; preserve valid SILK and transcode other audio. */
export async function qqVoiceBuffer(file: string): Promise<Buffer> {
  const encoder = await loadSilkWasm();
  if (!encoder) throw new Error('SILK 编码器不可用');
  const input = fs.readFileSync(file);
  if (encoder.isSilk(input)) return input;
  const pcm = await ffmpegToPCM('ffmpeg', file, 24000);
  if (!pcm.length) throw new Error('语音文件没有可用音频');
  return (await pcmToSilk(pcm, 24000)).silkBuffer;
}
