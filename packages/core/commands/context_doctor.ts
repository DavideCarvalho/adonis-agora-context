import AgoraDoctor from './agora_doctor.js';

/** `node ace context:doctor`: `agora:doctor --lib=context`. */
export default class ContextDoctor extends AgoraDoctor {
  static override commandName = 'context:doctor';
  static override description =
    'Check the @adonis-agora/context configuration (agora:doctor --lib=context)';

  protected override presetLib: string | undefined = 'context';
}
