/**
 * Logging utilities with chalk for colored output
 */

import chalk from 'chalk';

/**
 * Log levels
 */
export type LogLevel = 'info' | 'success' | 'warning' | 'error' | 'debug';

/**
 * Logger instance
 */
class Logger {
  private debugMode: boolean = false;

  /**
   * Enable or disable debug mode
   */
  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  /**
   * Log an info message
   */
  info(message: string): void {
    console.log(chalk.blue('ℹ'), message);
  }

  /**
   * Log a success message
   */
  success(message: string): void {
    console.log(chalk.green('✓'), message);
  }

  /**
   * Log a warning message
   */
  warning(message: string): void {
    console.log(chalk.yellow('⚠'), message);
  }

  /**
   * Log an error message
   */
  error(message: string): void {
    console.error(chalk.red('✗'), message);
  }

  /**
   * Log a debug message (only if debug mode is enabled)
   */
  debug(message: string): void {
    if (this.debugMode) {
      console.log(chalk.gray('DEBUG:'), message);
    }
  }

  /**
   * Log a message without any prefix
   */
  log(message: string): void {
    console.log(message);
  }

  /**
   * Log a dim/muted message
   */
  dim(message: string): void {
    console.log(chalk.dim(message));
  }

  /**
   * Log a bold message
   */
  bold(message: string): void {
    console.log(chalk.bold(message));
  }

  /**
   * Create a spinner-like loading message
   */
  loading(message: string): () => void {
    process.stdout.write(chalk.blue('⠋') + ' ' + message);

    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;

    const interval = setInterval(() => {
      process.stdout.write('\r' + chalk.blue(frames[i]) + ' ' + message);
      i = (i + 1) % frames.length;
    }, 80);

    // Return a function to stop the spinner
    return () => {
      clearInterval(interval);
      process.stdout.write('\r' + ' '.repeat(message.length + 2) + '\r');
    };
  }

  /**
   * Format a command for display
   */
  command(cmd: string): string {
    return chalk.cyan(cmd);
  }

  /**
   * Format a path for display
   */
  path(path: string): string {
    return chalk.magenta(path);
  }

  /**
   * Format a highlight for display
   */
  highlight(text: string): string {
    return chalk.yellow(text);
  }
}

// Export singleton instance
export const logger = new Logger();
