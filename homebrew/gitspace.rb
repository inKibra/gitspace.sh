# Homebrew formula for GitSpace CLI (gssh)
#
# To install from a tap:
#   brew tap inkibra/gitspace
#   brew install gitspace
#
# Or install directly from this file:
#   brew install --formula homebrew/gitspace.rb

class Gitspace < Formula
  desc "CLI for managing GitHub workspaces with git worktrees and secure remote terminal access"
  homepage "https://gitspace.sh"
  version "0.1.5"
  license "SEE LICENSE IN LICENSE"

  on_macos do
    on_arm do
      url "https://github.com/inkibra/gitspace.sh/releases/download/v#{version}/gssh-darwin-arm64.tar.gz"
      # sha256 "REPLACE_WITH_ACTUAL_SHA256"
    end
    on_intel do
      url "https://github.com/inkibra/gitspace.sh/releases/download/v#{version}/gssh-darwin-x64.tar.gz"
      # sha256 "REPLACE_WITH_ACTUAL_SHA256"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/inkibra/gitspace.sh/releases/download/v#{version}/gssh-linux-arm64.tar.gz"
      # sha256 "REPLACE_WITH_ACTUAL_SHA256"
    end
    on_intel do
      url "https://github.com/inkibra/gitspace.sh/releases/download/v#{version}/gssh-linux-x64.tar.gz"
      # sha256 "REPLACE_WITH_ACTUAL_SHA256"
    end
  end

  def install
    bin.install "gssh"
  end

  test do
    assert_match "gssh", shell_output("#{bin}/gssh --version")
  end
end
