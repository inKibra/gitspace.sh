import type { PortableNatives } from '@gitspace/protocol/machine-release';

export const BUN_VERSION = '1.4.0';

/**
 * The upstream native files every machine runs, per platform: the release asset as published (URL, SHA-256, size), the
 * executable inside it, and the oldest system that executable runs on. Measured once from the downloaded assets:
 * digests with `sha256sum` (they match upstream's published checksums: Bun's release API digests, git-lfs's signed
 * sha256sums.asc, ripgrep's adjacent .sha256 assets); the glibc floor is the newest `GLIBC_` version `readelf
 * --version-info` lists (null: statically linked); the macOS floor is the Mach-O `LC_BUILD_VERSION` minos. A machine build
 * checks its own platform's archive and executable against these; the portable release names all four.
 */
export const NATIVE_PINS: PortableNatives = {
  'darwin-arm64': {
    bun: {
      version: BUN_VERSION, url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-aarch64.zip',
      sha256: 'c669e97f6164e1c96e0701748db98dfa77492908cbd8394c7557134a735de381', size: 25_568_657, member: 'bun-darwin-aarch64/bun',
      executable: { sha256: '539598c775882420b9d8deb7dc14d845f20f7d26f5600c50ab067dde6ac3f3bf', size: 63_558_256 }, abi: { os: 'darwin', macos: '13.0' },
    },
    rg: {
      version: '14.1.1', url: 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-aarch64-apple-darwin.tar.gz',
      sha256: '24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be', size: 1_787_248, member: 'ripgrep-14.1.1-aarch64-apple-darwin/rg',
      executable: { sha256: '0e0cb83f5195f1f51bb8feef1fff5b0b171e82bd1db6bd35deee701a3e7102f8', size: 4_375_216 }, abi: { os: 'darwin', macos: '13.0' },
    },
    'git-lfs': {
      version: '3.8.0', url: 'https://github.com/git-lfs/git-lfs/releases/download/v3.8.0/git-lfs-darwin-arm64-v3.8.0.zip',
      sha256: 'caff76a7d070d8160c89bc39b6e85d98f24135b6fed038a3b4de2590d25102d8', size: 5_550_634, member: 'git-lfs-3.8.0/git-lfs',
      executable: { sha256: '8cb21d1fa650af82a06eaa98c6078303bacf2f101199be3d77ab7370ec712bd0', size: 13_255_424 }, abi: { os: 'darwin', macos: '13.0' },
    },
  },
  'darwin-x64': {
    bun: {
      version: BUN_VERSION, url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-x64-baseline.zip',
      sha256: 'da9b9f1b4ba766c6f299711f38dfaa98623e1ed9c40896aa53db803c52ec1fa0', size: 28_579_695, member: 'bun-darwin-x64-baseline/bun',
      executable: { sha256: 'ca8a18d0116d7b6b19f53bb0d8c48e487c0757cab4dc3f4f8cc5e43a44cd75d8', size: 70_704_544 }, abi: { os: 'darwin', macos: '13.0' },
    },
    rg: {
      version: '14.1.1', url: 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-apple-darwin.tar.gz',
      sha256: 'fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3', size: 2_082_672, member: 'ripgrep-14.1.1-x86_64-apple-darwin/rg',
      executable: { sha256: '923dcc25cab57d33f4e7dd0476d4b74a554401a38817e246a8d6101dcd51c50f', size: 5_162_504 }, abi: { os: 'darwin', macos: '14.0' },
    },
    'git-lfs': {
      version: '3.8.0', url: 'https://github.com/git-lfs/git-lfs/releases/download/v3.8.0/git-lfs-darwin-amd64-v3.8.0.zip',
      sha256: 'f1c17aeca0b4eaab9ea606226477dbed3b84b56fe0811a9f967d2ea2b2393c53', size: 6_198_060, member: 'git-lfs-3.8.0/git-lfs',
      executable: { sha256: '1c26c24df68c8493be6f1ba546fcc863d9fbbe2e3e1b72f892d1dcb7ad4f2e13', size: 14_439_600 }, abi: { os: 'darwin', macos: '13.0' },
    },
  },
  'linux-arm64': {
    bun: {
      version: BUN_VERSION, url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-aarch64.zip',
      sha256: '4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e', size: 36_641_863, member: 'bun-linux-aarch64/bun',
      executable: { sha256: '086c4121c8738a8e0f5ed730e8a461bc3973b4444e372ddb77aef9a747fa2ae9', size: 80_600_240 }, abi: { os: 'linux', glibc: '2.17' },
    },
    rg: {
      version: '14.1.1', url: 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz',
      sha256: 'c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f', size: 2_047_405, member: 'ripgrep-14.1.1-aarch64-unknown-linux-gnu/rg',
      executable: { sha256: 'e07d5c85fa9ca740ff4ab8bbac60a1e11c7a5ce242435f7820a03f7c20ef6276', size: 5_233_424 }, abi: { os: 'linux', glibc: '2.18' },
    },
    'git-lfs': {
      version: '3.8.0', url: 'https://github.com/git-lfs/git-lfs/releases/download/v3.8.0/git-lfs-linux-arm64-v3.8.0.tar.gz',
      sha256: 'ac9c8efac980bb0505ead384d087e2acb6486fd8498691a2165fa174ec6118c2', size: 5_341_074, member: 'git-lfs-3.8.0/git-lfs',
      executable: { sha256: 'd8a6a1743cae5b9bf6ac42bbcb61708514135c6045cfed8c283874ed63e1b282', size: 12_910_752 }, abi: { os: 'linux', glibc: null },
    },
  },
  'linux-x64': {
    bun: {
      version: BUN_VERSION, url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-x64-baseline.zip',
      sha256: '184fb4595f0d401a217cf7c78c1bc430ba83314dab7a8b94805babbf7fa7097f', size: 36_697_583, member: 'bun-linux-x64-baseline/bun',
      executable: { sha256: '33d56b070be6a9e3da0ab013038b43d1645d0534ca811ecdba4472599117eb4b', size: 80_761_952 }, abi: { os: 'linux', glibc: '2.17' },
    },
    // Upstream's static musl executable: no glibc requirement.
    rg: {
      version: '14.1.1', url: 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz',
      sha256: '4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e', size: 2_566_310, member: 'ripgrep-14.1.1-x86_64-unknown-linux-musl/rg',
      executable: { sha256: 'f401154e2393f9002ac77e419f9ee5521c18f4f8cd3e32293972f493ba06fce7', size: 6_597_984 }, abi: { os: 'linux', glibc: null },
    },
    'git-lfs': {
      version: '3.8.0', url: 'https://github.com/git-lfs/git-lfs/releases/download/v3.8.0/git-lfs-linux-amd64-v3.8.0.tar.gz',
      sha256: 'e455e00f15d9b95661b8d53498ffb0c3367962cf1ec73c31ab7369516cd6ab8d', size: 5_909_255, member: 'git-lfs-3.8.0/git-lfs',
      executable: { sha256: '1c636bd72c8f57f639fffbd13679066eb5fecea5c5a8212d3bda30d3a20768a5', size: 13_947_040 }, abi: { os: 'linux', glibc: null },
    },
  },
};
