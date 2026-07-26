A `manim` block renders to a video and the reading view shows the film in place
of the code.

```manim
from manim import *

class Hello(Scene):
    def construct(self):
        self.play(Write(Text("Tulip")))
        self.wait()
```

Naming the scene on the fence works too, for a block with several:

```manim Second
from manim import *

class First(Scene):
    def construct(self):
        self.play(Create(Circle()))

class Second(Scene):
    def construct(self):
        self.play(Create(Square()))
```

A scene that does not compile reports what Manim said:

```manim
from manim import *

class Broken(Scene):
    def construct(self):
        self.play(BOOM)
```
