# Test file

One note that exercises everything. **Bold**, *italic*, ~~struck~~, `inline code`, a [link](https://example.com), a [[Test file|wikilink]], and a #tag.

> A blockquote, set apart in italic with the accent rule.

---

## Tasks

- [x] a finished task
- [ ] an unfinished one
- plain bullet for comparison

## Table

| Language | Kind        | Price |
| -------- | ----------- | ----: |
| Lean     | proofs      | $0.00 |
| Rust     | compiled    | $1.50 |
| Julia    | JIT         | $2.25 |

## Maths and money

Inline maths $e^{i\pi} + 1 = 0$ sits in the sentence; a price like $12.99 stays money, not maths.

$$\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}$$

## Running code

```js
const primes = [2, 3, 5, 7, 11]
console.log('sum:', primes.reduce((a, b) => a + b))
console.warn('warnings arrive on the other channel')
```

```python
print("hello from python3")
```

```sh
echo "hello from sh"
pwd
```

A non-zero exit is the one thing the panel says loudly.

```python
import sys
print("could not reach the thing", file=sys.stderr)
sys.exit(3)
```

A runaway block can be stopped with the same control.

```sh
echo "starting"
sleep 60
echo "never reached"
```

## Compiled and slower-starting languages

```rust
fn main() {
    let primes = [2, 3, 5, 7, 11];
    println!("sum: {}", primes.iter().sum::<i32>());
}
```

```go
package main

import "fmt"

func main() {
	fmt.Println("sum:", 2+3+5+7+11)
}
```

```julia
primes = [2, 3, 5, 7, 11]
println("sum: ", sum(primes))
```

## Lean

Lean checks the block and prints its `#eval`s; define a `main` and it runs that instead.

```lean
#eval 2 + 2
#eval List.range 5 |>.map (· ^ 2)
```

## Not runnable

A language Tulip highlights but cannot run keeps a plain header.

```toml
[package]
name = "not-runnable"
```

## Manim

Press **Render** and the video takes the block's place; **Code** brings the source back. The film is saved into the vault and found again next time the note opens.

```manim
from manim import *

class Hello(Scene):
    def construct(self):
        square = Square(color=BLUE).shift(LEFT * 2)
        circle = Circle(color=GREEN).shift(RIGHT * 2)
        self.play(Create(square), Create(circle))
        self.play(Transform(square, circle.copy().shift(LEFT * 4)))
        self.play(Write(Text("Tulip").scale(1.5)))
        self.wait()
```
