"""Plot actual mining trials, their mean and minimum/maximum dispersion on a log time axis."""
import json
from pathlib import Path
import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt

root = Path(__file__).resolve().parents[1]
data = json.loads((root / 'reports/experiment.json').read_text())
summary = data['summary']
x = [row['difficulty'] for row in summary]
means = [row['meanMilliseconds'] for row in summary]
lower = [row['meanMilliseconds'] - row['minimumMilliseconds'] for row in summary]
upper = [row['maximumMilliseconds'] - row['meanMilliseconds'] for row in summary]

fig, axis = plt.subplots(figsize=(9, 6))
for row in summary:
    values = [sample['milliseconds'] for sample in data['samples'] if sample['difficulty'] == row['difficulty']]
    jitter = [row['difficulty'] + (i / max(1, len(values) - 1) - 0.5) * 0.12 for i in range(len(values))]
    axis.scatter(jitter, values, color='#76858d', alpha=0.7, s=22, zorder=2)
axis.errorbar(x, means, yerr=[lower, upper], fmt='o-', color='#166778', capsize=5,
              label='Mean with observed min/max range', zorder=3)
axis.plot(x, [means[0] * 16 ** (difficulty - x[0]) for difficulty in x], '--', color='#a55732',
          label='16x per extra hex zero, calibrated at difficulty 1')
axis.set_yscale('log')
axis.set_xticks(x)
axis.set_xlabel('Difficulty (leading hexadecimal zeros)')
axis.set_ylabel('Mining wall time (ms, logarithmic scale)')
axis.set_title('SHA-256 Proof of Work: ' + str(data['runsPerDifficulty']) + ' trials per difficulty')
axis.grid(True, which='both', alpha=0.2)
axis.legend(fontsize=9)
fig.tight_layout()
fig.savefig(root / 'reports/mining-difficulty.png', dpi=200)
fig.savefig(root / 'reports/mining-difficulty.pdf')
print('Saved reports/mining-difficulty.png and .pdf')
