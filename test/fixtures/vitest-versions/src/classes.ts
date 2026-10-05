export class Account {
  balance = 0
  label = 'account'
  onChange = (delta: number): number => this.balance + delta
  onClose = (): string => 'closed'
  static registry = new Map<string, Account>()
  static {
    Account.registry.set('default', new Account(0))
  }

  constructor(opening: number) {
    this.balance = opening
  }

  get doubled(): number {
    return this.balance * 2
  }

  set amount(v: number) {
    this.balance = v
  }

  deposit(n: number): number {
    this.balance += n > 0 ? n : n === 0 ? 0 : -n
    return this.balance
  }

  static create(): Account {
    return new Account(5)
  }
}
