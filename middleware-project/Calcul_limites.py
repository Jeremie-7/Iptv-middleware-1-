# Partie 2
import matplotlib.pyplot as plt
import numpy as np
import sympy as sp

# x=np.linspace(0,2,400)
# y=(x**2-1)/(x-1)

# plt.plot(x,y)
# plt.axvline(1, linestyle="--")
# plt.title("comportement de la fonction pres de x=1")
# plt.show()

# autour de 1 la valeur tends vers 2
# On pale de trou dans la courbe car 


#Partie 3

# import sympy as sp

# x = sp.symbols('x')
# f = (x**2-1)/(x-1)
# limite = sp.limit(f,x,1)

# print("limite =", limite)
# print(sp.simplify(f))

#La lmite renvoyé par la fonction est 2 donc cela est coherent par rapport a la partie 1
# apres avoir ajouter la ligne "print(sp.simplify(f))" on observe que le calcule a ete simplfié grace a une identité remarquable. On rappel: (a**2 + b**2) = (a+b)(a-b) --> d'ou le x + 1



# import sympy as sp
# x = sp.symbols('x')
# f = (3*x**2 + 1) / (x**2 -2)
# limite = sp.limit(f, x, -(sp.oo))
# print("limite = ", limite)

# x=np.linspace(100,-100,100)
# f = (3*x**2 + 1) / (x**2 -2)

# plt.plot(x,f)
# plt.axvline(0, linestyle="--")
# plt.title("comportement de la fonction")
# plt.show()

#On remarque que cela tend vers 3 et cela est coherent lorsque que l'on affiche le graphique cela se verifie  
# c'est la limite de f(x) lorsque x tends vers -oo et +oo 


#Partie 6 
# import sympy as sp
# x = sp.symbols('x')

# f3 = 1/x
# print(sp.limit(f3 , x ,0 , dir = '+'))
# print(sp.limit(f3 , x ,0 , dir = '-'))

#Les deux limies sont differentes car dans un cas x tends vers 0 posiif et l'autre 0 negatif car on ne peut pas diviser par 0 ( dans le cas de limite lorsqu'on divse par 0 alors cela tend vers l'infini (positif ou negatif en fonction de  si c'est un zero negatif (-0) ou positif (+0))
# On obtient une asymptote verticale


#Partie7

def etudier_limite (expression: str, valeur: float):
    try:
        x = sp.symbols('x')
        expr = sp.sympify(expression)
        limite = sp.limit(expr, x, valeur)
        print(f"La limite de {expression} quand x → {valeur} est: {limite}")
        return limite
    except Exception as e:
        print(f"Erreur lors du calcul de la limite: {e}")
        return None
    
etudier_limite(sin(x))
