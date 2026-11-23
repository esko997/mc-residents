"""speak.py: the caretaker's note reaches only the resident it is for.

    python3 -m unittest full-client/overseer/test_speak.py
"""
import importlib.util, json, os, unittest

spec = importlib.util.spec_from_file_location("speak", os.path.join(os.path.dirname(os.path.abspath(__file__)), "speak.py"))
speak = importlib.util.module_from_spec(spec)
spec.loader.exec_module(speak)


class Speak(unittest.TestCase):
    def test_tellraw_goes_to_the_addressee_alone(self):
        command = speak.command_for("Gary", 'Auto-eat is off and you carry no "food".')
        target, _, payload = command[len("tellraw "):].partition(" ")
        self.assertEqual(target, "Gary")
        self.assertEqual(json.loads(payload), {"text": '<Caretaker> Gary: Auto-eat is off and you carry no "food".'})

    def test_a_name_that_could_be_a_selector_is_refused(self):
        for name in ("@a", "Gary @a", "", "a" * 17):
            with self.assertRaises(ValueError):
                speak.command_for(name, "hello")


if __name__ == "__main__":
    unittest.main()
