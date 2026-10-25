import Phaser from 'phaser'

export class TableScene extends Phaser.Scene {
  constructor() {
    super('TableScene')
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#064e3b')
  }
}
