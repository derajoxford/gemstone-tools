import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { getAllianceApiKey, queryAllianceBankrecs, setAllianceCursor, getAllianceCursor, BankrecFilter } from '../lib/pnw_bank_ingest';

export const data = new SlashCommandBuilder()
  .setName('pnw_bankpeek')
  .setDescription('Preview recent alliance bank records')
  .addIntegerOption(opt =>
    opt.setName('alliance_id')
      .setDescription('Alliance ID')
      .setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName('filter')
      .setDescription('Filter by type')
      .addChoices(
        { name: 'all', value: 'all' },
        { name: 'tax', value: 'tax' },
        { name: 'nontax', value: 'nontax' },
      )
      .setRequired(false)
  )
  .addIntegerOption(opt =>
    opt.setName('limit')
      .setDescription('How many to show (default 8)')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger('alliance_id', true);
  const filter = (interaction.options.getString('filter') ?? 'all') as BankrecFilter;
  const limit = Math.max(1, Math.min(50, interaction.options.getInteger('limit') ?? 8));

  await interaction.deferReply();

  try {
    const apiKey = await getAllianceApiKey(allianceId);
    if (!apiKey) {
      await interaction.editReply(`❌ No API key on file for alliance ${allianceId}. Use the config command to store a key.`);
      return;
    }

    // Use any stored cursor to skip old rows (optional, improves UX)
    const cursor = await getAllianceCursor(allianceId);
    const afterId = cursor?.lastSeenId;

    const rows = await queryAllianceBankrecs({
      allianceId,
      apiKey,
      limit,
      afterId,
      filter,
    });

    if (rows.length === 0) {
      await interaction.editReply(`Alliance ${allianceId} • after_id=${afterId ?? '-'} • filter=${filter} • limit=${limit}\n\nNo bank records found.`);
      return;
    }

    // advance cursor to newest id we just showed (best-effort)
    const newestId = rows.reduce((m, r) => (r.id > m ? r.id : m), afterId ?? '0');
    await setAllianceCursor(allianceId, newestId);

    const lines = rows.map(r => {
      const tax = r.tax_id && r.tax_id !== '0' ? ` (tax_id ${r.tax_id})` : '';
      const parties = `${r.sender_type}:${r.sender_id} -> ${r.receiver_type}:${r.receiver_id}`;
      return `• #${r.id}${tax} — ${parties}${r.note ? ` — ${r.note}` : ''}`;
    });

    await interaction.editReply(
      `Alliance ${allianceId} • after_id=${afterId ?? '-'} • filter=${filter} • limit=${limit}\n\n` +
      lines.join('\n')
    );
  } catch (err: any) {
    await interaction.editReply(`❌ Error: ${err.message ?? String(err)}`);
    throw err;
  }
}
